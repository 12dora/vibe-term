// 节点间传输的一次性授权（在目标节点 B 上签发）。
//
// `/api/mesh-internal/*` 只认 peer 标记，也就是「任何一台受信任节点都能调」；没有这层授权，
// 任意节点都可以往别的节点上写文件。所以浏览器必须先用自己的 B 会话换一张 grant，
// 绑死「哪个源节点、写到哪个 root 的哪个目录」，A 建会话时一次性核销。

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const GRANT_TTL_MS = 10 * 60_000;

export interface TransferGrant {
  id: string;
  token: string;
  fromNodeId: string;
  destRootId: string;
  destPath: string;
  uid: string;
  expiresAt: number;
  consumed: boolean;
}

export type GrantFailure = 'grant_invalid' | 'grant_expired' | 'peer_mismatch';

const grants = new Map<string, TransferGrant>();

function sweep(now: number): void {
  for (const [id, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(id);
  }
}

export function createGrant(input: {
  fromNodeId: string;
  destRootId: string;
  destPath: string;
  uid: string;
  now?: number;
}): TransferGrant {
  const now = input.now ?? Date.now();
  sweep(now);
  const grant: TransferGrant = {
    id: randomBytes(16).toString('hex'),
    token: randomBytes(32).toString('hex'),
    fromNodeId: input.fromNodeId,
    destRootId: input.destRootId,
    destPath: input.destPath,
    uid: input.uid,
    expiresAt: now + GRANT_TTL_MS,
    consumed: false,
  };
  grants.set(grant.id, grant);
  return grant;
}

function tokenMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 一次性核销：成功后立即置 consumed，重放拿不到第二个会话。 */
export function consumeGrant(input: {
  grantId: string;
  token: string;
  peerNodeId: string;
  now?: number;
}): { ok: true; grant: TransferGrant } | { ok: false; code: GrantFailure } {
  const now = input.now ?? Date.now();
  const grant = grants.get(input.grantId);
  if (!grant || grant.consumed) return { ok: false, code: 'grant_invalid' };
  if (grant.expiresAt <= now) {
    grants.delete(grant.id);
    return { ok: false, code: 'grant_expired' };
  }
  if (!tokenMatches(grant.token, input.token)) return { ok: false, code: 'grant_invalid' };
  if (grant.fromNodeId !== input.peerNodeId) return { ok: false, code: 'peer_mismatch' };
  grant.consumed = true;
  grants.delete(grant.id);
  return { ok: true, grant };
}

export function resetTransferGrantsForTests(): void {
  grants.clear();
}
