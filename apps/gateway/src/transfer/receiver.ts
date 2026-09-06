// 目标节点 B 上的接收服务：会话生命周期 + 预算。区间落盘与落位在 `receiver-files.ts`。
// mesh-internal 路由与「A 就是 B」的本机复制都走这一份，保证两条路径的语义完全一致。

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TransferCapability, TransferErrorCode } from '@tmex/shared';
import type { SinkDescriptor } from '@tmex/transfer/node';
import { config } from '../config';
import { transferMaxBytesNow } from '../files/transfer-limit';
import type { DestContext } from './dest';
import { resolveDestContext } from './dest';
import { type TransferGrant, consumeGrant } from './grants';
import {
  MAX_SESSIONS_PER_PEER,
  MAX_SESSIONS_TOTAL,
  SESSION_IDLE_MS,
  sessionMaxBytes,
  transferChunkBytes,
} from './limits';
import { receiverSink } from './receiver-sink';

export { SESSION_IDLE_MS, TRANSFER_CHUNK_BYTES } from './limits';

export const RECEIVER_CAPABILITIES: TransferCapability[] = [
  'transfer-v2',
  'transfer-ranged-parallel',
];

export interface ReceivingFile {
  relPath: string;
  size: number;
  descriptor: SinkDescriptor;
  /** ssh 目标：先落到本机暂存，落位时再 rsync 推过去 */
  staged: boolean;
  /** 本机 rename 已完成（ssh 目标此时字节在暂存目录里） */
  stagedDone: boolean;
  /** 最终落位完成：本机目标 = rename 成功，ssh 目标 = rsync 成功 */
  committed: boolean;
  /** 目标已存在且策略为 skip */
  skipped: boolean;
  /** 本进程内对该半成品的独占声明（partPath） */
  partClaim: string | null;
}

export interface TransferSession {
  id: string;
  fromNodeId: string;
  uid: string;
  dest: DestContext;
  onConflict: 'skip' | 'overwrite';
  /** grant 作用域：同一 root + 同一授权目录，跨会话可续传同一个半成品 */
  scopeKey: string;
  /** ssh 目标的本机暂存目录（按作用域确定，重启后仍能接上） */
  stagingDir: string | null;
  files: Map<string, ReceivingFile>;
  createdAt: number;
  lastUsedAt: number;
  maxFileBytes: number;
  maxBytes: number;
  bytesRegistered: number;
  activeOps: number;
  activeWrites: number;
  closing: boolean;
  closed: Promise<void> | null;
  abort: AbortController;
  idleWaiters: Array<() => void>;
}

const sessions = new Map<string, TransferSession>();
/** partPath → sessionId：同一半成品同一时刻只允许一个会话在写。 */
const partOwners = new Map<string, string>();

export interface OpenSessionResult {
  sessionId: string;
  capabilities: TransferCapability[];
  maxFileBytes: number;
  chunkSize: number;
  expiresAt: number;
}

export type ReceiverFailure = { ok: false; code: TransferErrorCode; detail?: string };
export type ReceiverResult<T> = ({ ok: true } & T) | ReceiverFailure;
export type ReceiverVoid = { ok: true } | ReceiverFailure;

export function receiverFail(code: TransferErrorCode, detail?: string): ReceiverFailure {
  return { ok: false, code, detail };
}

function scopeKeyOf(grant: TransferGrant, dest: DestContext): string {
  return `${grant.destRootId}\0${dest.realDestDir}`;
}

function stagingDirFor(scopeKey: string): string {
  const digest = createHash('sha256').update(scopeKey).digest('hex').slice(0, 16);
  return join(tmpdir(), `tmex-rx-${digest}`);
}

function countSessionsFor(peerNodeId: string): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (!session.closing && session.fromNodeId === peerNodeId) count += 1;
  }
  return count;
}

function sweep(now: number): void {
  for (const [id, session] of sessions) {
    if (session.closing) continue;
    if (session.activeOps > 0) continue;
    if (now - session.lastUsedAt > SESSION_IDLE_MS) void closeSession(id);
  }
}

export function openSession(input: {
  grantId: string;
  token: string;
  peerNodeId: string;
  onConflict?: 'skip' | 'overwrite';
  now?: number;
}): ReceiverResult<OpenSessionResult> {
  const now = input.now ?? Date.now();
  sweep(now);
  if (sessions.size >= MAX_SESSIONS_TOTAL) return receiverFail('limit_exceeded');
  if (countSessionsFor(input.peerNodeId) >= MAX_SESSIONS_PER_PEER) {
    return receiverFail('limit_exceeded');
  }
  const consumed = consumeGrant({
    grantId: input.grantId,
    token: input.token,
    peerNodeId: input.peerNodeId,
    now,
  });
  if (!consumed.ok) return receiverFail(consumed.code);
  return startSession(consumed.grant, input.onConflict ?? 'skip', now);
}

function startSession(
  grant: TransferGrant,
  onConflict: 'skip' | 'overwrite',
  now: number
): ReceiverResult<OpenSessionResult> {
  const dest = resolveDestContext(grant.destRootId, grant.destPath);
  if (!dest.ok) return receiverFail(dest.code);
  const maxFileBytes = transferMaxBytesNow(config.transferMaxBytes);
  const scopeKey = scopeKeyOf(grant, dest.data);
  const session: TransferSession = {
    id: randomBytes(16).toString('hex'),
    fromNodeId: grant.fromNodeId,
    uid: grant.uid,
    dest: dest.data,
    onConflict,
    scopeKey,
    stagingDir: dest.data.device.type === 'local' ? null : stagingDirFor(scopeKey),
    files: new Map(),
    createdAt: now,
    lastUsedAt: now,
    maxFileBytes,
    maxBytes: sessionMaxBytes(maxFileBytes),
    bytesRegistered: 0,
    activeOps: 0,
    activeWrites: 0,
    closing: false,
    closed: null,
    abort: new AbortController(),
    idleWaiters: [],
  };
  if (session.stagingDir) {
    try {
      mkdirSync(session.stagingDir, { recursive: true, mode: 0o700 });
    } catch {
      return receiverFail('permission_denied');
    }
  }
  sessions.set(session.id, session);
  return {
    ok: true,
    sessionId: session.id,
    capabilities: RECEIVER_CAPABILITIES,
    maxFileBytes,
    chunkSize: transferChunkBytes(),
    expiresAt: now + SESSION_IDLE_MS,
  };
}

/** 先判过期再续期：晚到的请求不能把已经该回收的会话救活。 */
export function getSession(sessionId: string, peerNodeId: string): TransferSession | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.fromNodeId !== peerNodeId) return null;
  if (session.closing) return null;
  const now = Date.now();
  if (session.activeOps === 0 && now - session.lastUsedAt > SESSION_IDLE_MS) {
    void closeSession(sessionId);
    return null;
  }
  session.lastUsedAt = now;
  return session;
}

/** 字节在动就算活着：一个 8 MiB 分片传十分钟也不该被空闲回收掉。 */
export function touchSession(session: TransferSession): void {
  session.lastUsedAt = Date.now();
}

export function beginOp(session: TransferSession): ReceiverVoid {
  if (session.closing) return receiverFail('cancelled');
  session.activeOps += 1;
  session.lastUsedAt = Date.now();
  return { ok: true };
}

export function endOp(session: TransferSession): void {
  session.activeOps = Math.max(0, session.activeOps - 1);
  session.lastUsedAt = Date.now();
  if (session.activeOps === 0) {
    const waiters = session.idleWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}

function whenIdle(session: TransferSession): Promise<void> {
  if (session.activeOps === 0) return Promise.resolve();
  return new Promise<void>((resolve) => session.idleWaiters.push(resolve));
}

/** 半成品的进程内独占：两个会话同时写同一个 `.part` 会互相踩，第二个直接判冲突。 */
export function claimPart(session: TransferSession, partPath: string): boolean {
  const owner = partOwners.get(partPath);
  if (owner && owner !== session.id) return false;
  partOwners.set(partPath, session.id);
  return true;
}

export function releasePart(session: TransferSession, partPath: string): void {
  if (partOwners.get(partPath) === session.id) partOwners.delete(partPath);
}

/**
 * 关闭：先置 closing 拦住新操作，再等在跑的操作收尾，最后才丢弃半成品并摘掉会话。
 * 顺序反了会出现「清理跑完之后又冒出一个 `.rx` 旁挂文件」这种没人再管得到的残留。
 */
export function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return Promise.resolve();
  if (session.closed) return session.closed;
  session.closing = true;
  session.abort.abort();
  session.closed = (async () => {
    await whenIdle(session);
    for (const file of session.files.values()) {
      if (!file.committed) await receiverSink.discard(file.descriptor).catch(() => {});
      if (file.staged && file.stagedDone) {
        await rm(file.descriptor.destPath, { force: true }).catch(() => {});
      }
      if (file.partClaim) releasePart(session, file.partClaim);
    }
    if (session.stagingDir && !hasLiveStagingPeer(session)) {
      try {
        rmdirSync(session.stagingDir);
      } catch {
        // 目录里还有别的会话的暂存文件：留着，交给孤儿清扫按 TTL 处理
      }
    }
    sessions.delete(sessionId);
  })();
  return session.closed;
}

function hasLiveStagingPeer(session: TransferSession): boolean {
  for (const other of sessions.values()) {
    if (other.id !== session.id && other.stagingDir === session.stagingDir) return true;
  }
  return false;
}

export function activeSessionCount(): number {
  return sessions.size;
}

/** 测试用：模拟进程崩溃——只丢掉内存里的会话表，盘上的半成品原样留着。 */
export function forgetTransferSessionsForTests(): void {
  sessions.clear();
  partOwners.clear();
}

export function isPartClaimed(partPath: string): boolean {
  return partOwners.has(partPath);
}

/** 正在被会话使用的暂存目录：孤儿清扫要绕开它们。 */
export function activeStagingDirs(): Set<string> {
  const dirs = new Set<string>();
  for (const session of sessions.values()) {
    if (session.stagingDir) dirs.add(session.stagingDir);
  }
  return dirs;
}

// 空闲会话的兜底 GC：没有新会话进来时也要把半成品清掉，别把 `.part` 留在用户目录里。
const sessionGcTimer = setInterval(() => sweep(Date.now()), 60_000);
sessionGcTimer.unref?.();

export async function resetTransferSessionsForTests(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => closeSession(id)));
  sessions.clear();
  partOwners.clear();
}
