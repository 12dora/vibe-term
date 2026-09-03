// 没落账的 `meta-key` 换代：吊销 / 根轮换 / admit 补发之后那一条记录如果没送上去，
// 元数据密钥就停在旧世代——被吊销的节点仍能解出中继转发的元数据块（plan §1.4、§1.12）。
//
// 因此它不能只弹一条 toast 了事：意向落 sessionStorage，页面刷新、切标签、重开设置页之后
// 仍然看得到「还欠一条」，并且能自动重发。
//
// **存的是公开数据**：`op` 里只有节点 id，`record` 是已签好的密钥日志记录字节（payload 里的
// 租户密钥早已按各节点的 X25519 公钥封装过）。根钥 seed、口令一概不进这里。

import type { RecordSigner } from '@/auth/key-log-actions';
import type { RelayMetaKeyOp } from '@tmex/api-client/relay/tenant-api';
import {
  type RelayFlowDeps,
  type RelayFlowResult,
  type SignedRelayRecord,
  appendMetaKey,
  resendRelayRecord,
} from './relay-enroll';

export const RELAY_META_KEY_STORAGE_KEY = 'tmex.relay.metaKeyPending';

/** 欠着的那一条换代。`record` 为 `null` 表示当时连签都没签成，重试要重新要凭据。 */
export interface PendingMetaKey {
  id: string;
  /** 触发来源，只用于文案。 */
  reason: 'revoke' | 'admit' | 'rotateRoot' | 'manual';
  op: RelayMetaKeyOp;
  createdAt: number;
  record: SignedRelayRecord | null;
}

let entries: PendingMetaKey[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
}

function parseEntry(raw: unknown): PendingMetaKey | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const op = row.op as RelayMetaKeyOp | undefined;
  if (typeof row.id !== 'string' || !row.id) return null;
  if (!op || (op.op !== 'admit' && op.op !== 'rotate')) return null;
  const record = row.record as SignedRelayRecord | null | undefined;
  return {
    id: row.id,
    reason: reasonOf(row.reason),
    op,
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
    record:
      record && typeof record.bytes === 'string' && typeof record.sig === 'string' ? record : null,
  };
}

function reasonOf(value: unknown): PendingMetaKey['reason'] {
  return value === 'revoke' || value === 'admit' || value === 'rotateRoot' || value === 'manual'
    ? value
    : 'manual';
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = storage()?.getItem(RELAY_META_KEY_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return;
    entries = parsed.map(parseEntry).filter((row): row is PendingMetaKey => row !== null);
  } catch {
    entries = [];
  }
}

function persist(): void {
  try {
    const store = storage();
    if (!store) return;
    if (entries.length === 0) store.removeItem(RELAY_META_KEY_STORAGE_KEY);
    else store.setItem(RELAY_META_KEY_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 隐私模式下 sessionStorage 会抛；内存态仍然有效，刷新后丢失即可。
  }
}

function notify(): void {
  persist();
  for (const listener of [...listeners]) listener();
}

export function listPendingMetaKeys(): PendingMetaKey[] {
  load();
  return entries;
}

export function subscribePendingMetaKeys(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 记下一条欠账（同 id 覆盖：同一次吊销重试多次只留最新那份字节）。 */
export function rememberPendingMetaKey(entry: {
  id: string;
  reason: PendingMetaKey['reason'];
  op: RelayMetaKeyOp;
  record?: SignedRelayRecord | null;
  now?: number;
}): void {
  load();
  const next: PendingMetaKey = {
    id: entry.id,
    reason: entry.reason,
    op: entry.op,
    createdAt: entry.now ?? Date.now(),
    record: entry.record ?? null,
  };
  entries = [...entries.filter((row) => row.id !== entry.id), next];
  notify();
}

export function forgetPendingMetaKey(id: string): void {
  load();
  const next = entries.filter((row) => row.id !== id);
  if (next.length === entries.length) return;
  entries = next;
  notify();
}

export function clearPendingMetaKeysForTest(): void {
  entries = [];
  loaded = true;
  notify();
}

/**
 * 重试一条欠账。
 *
 * 手上有已签字节就原样重发（本地 head 没动，重签一个新 seq 反而会把上级顶成 `seq_gap`）；
 * 没有字节就得重新 `prepare` + 重签，那需要一把签名者——拿不到就原样留着，等用户点重试。
 */
export async function retryPendingMetaKey(
  deps: RelayFlowDeps,
  entry: PendingMetaKey,
  signer?: RecordSigner | null
): Promise<RelayFlowResult> {
  const result = entry.record
    ? await resendRelayRecord(deps, entry.record)
    : signer
      ? await appendMetaKey(deps, entry.op, signer)
      : { ok: false as const, code: 'RELAY_META_KEY_NEEDS_SIGNER' };
  if (result.ok) {
    forgetPendingMetaKey(entry.id);
    return result;
  }
  // 重发被判定为过期（`stale`）时 `record` 不会回来：清掉字节，下次带凭据重签。
  if (entry.record && !result.record) {
    rememberPendingMetaKey({ ...entry, record: null, now: entry.createdAt });
  } else if (!entry.record && result.record) {
    rememberPendingMetaKey({ ...entry, record: result.record, now: entry.createdAt });
  }
  return result;
}

/** 依次重试全部欠账（key log 是一条链，必须串行）。返回仍然欠着的条数。 */
export async function retryPendingMetaKeys(
  deps: RelayFlowDeps,
  signer?: RecordSigner | null
): Promise<number> {
  for (const entry of [...listPendingMetaKeys()]) {
    await retryPendingMetaKey(deps, entry, signer);
  }
  return listPendingMetaKeys().length;
}
