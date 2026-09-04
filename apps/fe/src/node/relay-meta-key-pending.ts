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

// ---------------------------------------------------------------------------
// 密封包欠账
// ---------------------------------------------------------------------------

export const RELAY_PACK_DEBT_STORAGE_KEY = 'tmex.relay.packDebt';

/**
 * 密封包没能重封（根轮换之后最典型：`rotate-root` 一落账全部会话即失效，这台浏览器连
 * `/api/mesh/relay/*` 都打不通；中继侧的根轮换 sidecar 还会把旧密封包清空）。
 *
 * 欠账按中继地址记：多中继时后端会逐台转发，A 成功 B 离线是常态，只有 B 该留着欠账。
 * 具体哪几台无从枚举时（根轮换、连材料都没取到）记 `all`，重试时整份重封。
 *
 * 存的只有地址：重封要用根种子，而根种子绝不落任何存储，用户下次回来得重新输一遍密码。
 * UX 与元数据密钥欠账同一套——页面挂告警 + 一个重试按钮。
 */
export interface RelayPackDebt {
  /** 全部中继都欠着（具体哪几台无从枚举）。 */
  all: boolean;
  /** 明确欠着的中继地址。 */
  urls: string[];
}

const NO_PACK_DEBT: RelayPackDebt = { all: false, urls: [] };

let packDebt: RelayPackDebt = NO_PACK_DEBT;
let packDebtLoaded = false;
const packDebtListeners = new Set<() => void>();

function parsePackDebt(raw: string | null): RelayPackDebt {
  if (!raw) return NO_PACK_DEBT;
  // 1.1.23 的布尔标记：升级上来的会话不该把欠账丢掉。
  if (raw === '1') return { all: true, urls: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return NO_PACK_DEBT;
    const row = parsed as { all?: unknown; urls?: unknown };
    const urls = Array.isArray(row.urls)
      ? row.urls.filter((url): url is string => typeof url === 'string' && url !== '')
      : [];
    const all = row.all === true;
    return all || urls.length > 0 ? { all, urls } : NO_PACK_DEBT;
  } catch {
    return NO_PACK_DEBT;
  }
}

function loadPackDebt(): void {
  if (packDebtLoaded) return;
  packDebtLoaded = true;
  try {
    packDebt = parsePackDebt(storage()?.getItem(RELAY_PACK_DEBT_STORAGE_KEY) ?? null);
  } catch {
    packDebt = NO_PACK_DEBT;
  }
}

function packDebtEquals(a: RelayPackDebt, b: RelayPackDebt): boolean {
  return (
    a.all === b.all &&
    a.urls.length === b.urls.length &&
    a.urls.every((url, i) => url === b.urls[i])
  );
}

function setPackDebt(next: RelayPackDebt): void {
  loadPackDebt();
  if (packDebtEquals(packDebt, next)) return;
  packDebt = next.all || next.urls.length > 0 ? next : NO_PACK_DEBT;
  try {
    const store = storage();
    if (!store) return;
    if (packDebt === NO_PACK_DEBT) store.removeItem(RELAY_PACK_DEBT_STORAGE_KEY);
    else store.setItem(RELAY_PACK_DEBT_STORAGE_KEY, JSON.stringify(packDebt));
  } catch {
    // 隐私模式下 sessionStorage 会抛；内存态仍然有效。
  } finally {
    for (const listener of [...packDebtListeners]) listener();
  }
}

export function relayPackDebt(): boolean {
  loadPackDebt();
  return packDebt !== NO_PACK_DEBT;
}

/** 欠账明细；引用稳定，可直接喂 `useSyncExternalStore`。 */
export function relayPackDebtDetail(): RelayPackDebt {
  loadPackDebt();
  return packDebt;
}

export function subscribeRelayPackDebt(listener: () => void): () => void {
  packDebtListeners.add(listener);
  return () => {
    packDebtListeners.delete(listener);
  };
}

/** 记一笔欠账；不给地址 = 具体哪几台不明，整份重封。 */
export function rememberRelayPackDebt(urls?: readonly string[]): void {
  loadPackDebt();
  if (!urls || urls.length === 0) {
    setPackDebt({ all: true, urls: packDebt.urls });
    return;
  }
  const merged = [...packDebt.urls];
  for (const url of urls) if (!merged.includes(url)) merged.push(url);
  setPackDebt({ all: packDebt.all, urls: merged });
}

/** 销账；不给地址 = 全部销掉（含 `all` 标记）。 */
export function forgetRelayPackDebt(urls?: readonly string[]): void {
  loadPackDebt();
  if (!urls || urls.length === 0) {
    setPackDebt(NO_PACK_DEBT);
    return;
  }
  setPackDebt({ all: packDebt.all, urls: packDebt.urls.filter((url) => !urls.includes(url)) });
}

export function clearRelayPackDebtForTest(): void {
  packDebtLoaded = true;
  setPackDebt(NO_PACK_DEBT);
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
