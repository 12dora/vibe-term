// 目标节点 Y 上的窗格授权账本。
//
// `/api/mesh-internal/tmux/*` 只认 peer 标记，也就是「任何一台受信任节点都能调」；
// 没有这层授权，任意已准入节点都可以往别的节点的任意窗格里注入按键、读走屏幕内容。
// 授权由浏览器用自己的 Y 会话签发（见 routes.ts），绑死「哪个源节点、哪台设备、哪个窗格、
// 哪一代 tmux server」，源节点每次 RPC 都必须带上。滑动过期：每次使用续 7 天，从签发起最多 30 天。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';
import type { AuthDb } from '../../auth/types';
import { getDb } from '../../db/client';
import { agentPaneGrants, nodeCerts } from '../../db/schema';

export const PANE_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PANE_GRANT_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface PaneGrantRecord {
  id: string;
  fromNodeId: string;
  deviceId: string;
  paneId: string;
  /** 签发时目标 tmux server 的世代；每次 RPC 由路由与运行时当前世代比对 */
  serverEpoch: string | null;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

export interface IssuedPaneGrant {
  grantId: string;
  token: string;
  expiresAt: number;
}

export type PaneGrantFailureCode = 'PANE_GRANT_REQUIRED' | 'PANE_GRANT_INVALID';

export type PaneGrantCheck =
  | { ok: true; grant: PaneGrantRecord }
  | { ok: false; code: PaneGrantFailureCode };

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function tokenMatches(expectedHash: string, token: string): boolean {
  const a = Buffer.from(expectedHash, 'utf8');
  const b = Buffer.from(hashToken(token), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 滑动续期封顶：从签发时刻起最多 30 天，之后必须重新签发。 */
function nextExpiry(createdAt: number, now: number): number {
  return Math.min(now + PANE_GRANT_TTL_MS, createdAt + PANE_GRANT_MAX_LIFETIME_MS);
}

export function sweepPaneGrants(now = Date.now()): void {
  getDb().delete(agentPaneGrants).where(lte(agentPaneGrants.expiresAt, now)).run();
}

export function issuePaneGrant(input: {
  fromNodeId: string;
  deviceId: string;
  paneId: string;
  serverEpoch: string;
  now?: number;
}): IssuedPaneGrant {
  const now = input.now ?? Date.now();
  sweepPaneGrants(now);
  const id = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('hex');
  getDb()
    .insert(agentPaneGrants)
    .values({
      id,
      tokenHash: hashToken(token),
      fromNodeId: input.fromNodeId,
      deviceId: input.deviceId,
      paneId: input.paneId,
      serverEpoch: input.serverEpoch,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + PANE_GRANT_TTL_MS,
    })
    .run();
  return { grantId: id, token, expiresAt: now + PANE_GRANT_TTL_MS };
}

type PaneGrantRow = typeof agentPaneGrants.$inferSelect;

function selectRow(id: string): PaneGrantRow | null {
  return getDb().select().from(agentPaneGrants).where(eq(agentPaneGrants.id, id)).get() ?? null;
}

function toRecord(row: PaneGrantRow): PaneGrantRecord {
  const { tokenHash: _tokenHash, ...record } = row;
  return record;
}

export function getPaneGrant(id: string): PaneGrantRecord | null {
  const row = selectRow(id);
  return row ? toRecord(row) : null;
}

export function deletePaneGrant(id: string): boolean {
  const existed = selectRow(id) !== null;
  getDb().delete(agentPaneGrants).where(eq(agentPaneGrants.id, id)).run();
  return existed;
}

/**
 * 节点被吊销：它手上的授权全部作废（吊销后重新准入必须重新签发）。
 * `db` 用于在吊销记录落库的同一个事务里删除——事务回滚时授权也跟着回来，两者不会各说各话。
 */
export function deletePaneGrantsForNode(fromNodeId: string, db: AuthDb = getDb()): void {
  db.delete(agentPaneGrants).where(eq(agentPaneGrants.fromNodeId, fromNodeId)).run();
}

/** 根密钥重置会删光全部节点证书，随之作废所有授权。 */
export function deleteAllPaneGrants(db: AuthDb = getDb()): void {
  db.delete(agentPaneGrants).run();
}

/**
 * 证书已被吊销的源节点：吊销时链路不一定已经断，授权这一层必须自己拒。
 * 没有证书行则不在此判——链路握手本身就要求证书，连不上就发不出这条 RPC；
 * 重新准入走 `admit-node`，那条会把 `revoked_log_seq` 清回 null。
 */
function certRevoked(nodeId: string): boolean {
  const cert = getDb()
    .select({ revokedLogSeq: nodeCerts.revokedLogSeq })
    .from(nodeCerts)
    .where(eq(nodeCerts.nodeId, nodeId))
    .get();
  return cert != null && cert.revokedLogSeq != null;
}

export function listPaneGrantsForNode(fromNodeId: string): PaneGrantRecord[] {
  return getDb()
    .select()
    .from(agentPaneGrants)
    .where(eq(agentPaneGrants.fromNodeId, fromNodeId))
    .all()
    .map(toRecord);
}

/**
 * 校验并续期。token 比对用哈希常量时间比较；源节点、设备、窗格三者必须与请求完全一致，
 * 源节点证书当前被吊销、或授权没绑 server 世代（旧记录）一律不认。
 * 任一不符都回 `PANE_GRANT_INVALID`（不区分原因，免得成为探测别的节点/窗格的口子）。
 * server 世代的比对在路由侧完成——那里才拿得到目标运行时的当前世代。
 */
export function verifyPaneGrant(input: {
  grantId: string;
  token: string;
  peerNodeId: string;
  deviceId: string;
  paneId: string;
  now?: number;
}): PaneGrantCheck {
  const now = input.now ?? Date.now();
  const row = selectRow(input.grantId);
  if (!row) return { ok: false, code: 'PANE_GRANT_INVALID' };
  if (row.expiresAt <= now) {
    deletePaneGrant(row.id);
    return { ok: false, code: 'PANE_GRANT_INVALID' };
  }
  if (!tokenMatches(row.tokenHash, input.token)) {
    return { ok: false, code: 'PANE_GRANT_INVALID' };
  }
  if (
    row.fromNodeId !== input.peerNodeId ||
    row.deviceId !== input.deviceId ||
    row.paneId !== input.paneId ||
    !row.serverEpoch
  ) {
    return { ok: false, code: 'PANE_GRANT_INVALID' };
  }
  if (certRevoked(row.fromNodeId)) {
    deletePaneGrantsForNode(row.fromNodeId);
    return { ok: false, code: 'PANE_GRANT_INVALID' };
  }
  const expiresAt = nextExpiry(row.createdAt, now);
  getDb()
    .update(agentPaneGrants)
    .set({ lastUsedAt: now, expiresAt })
    .where(and(eq(agentPaneGrants.id, row.id), eq(agentPaneGrants.fromNodeId, row.fromNodeId)))
    .run();
  return { ok: true, grant: { ...toRecord(row), lastUsedAt: now, expiresAt } };
}

function schedulePaneGrantSweep(): void {
  if (process.env.NODE_ENV === 'test') return;
  const timer = setInterval(() => {
    try {
      sweepPaneGrants();
    } catch {
      // 库还没就绪或正被迁移：下一拍再来
    }
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

schedulePaneGrantSweep();
