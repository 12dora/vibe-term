// 会话持有证明（PoP）的浏览器侧：登录钥在整个会话（硬上限 7 天）里逐请求签名。
//
// 为什么钥要单独保存：delegation 只有 18 小时，而 node 会话 cookie 能活到 7 天硬上限，
// 钥随 delegation 一起丢掉，会话就还在、却再也签不出证明。所以这里的钥与 `session-key-store`
// 的会话记录各自独立，只在登出 / 没有任何 node 会话引用它时才清。
//
// 钥按 node 绑定：重新登录会生成新的 `sk_sess`，其它 node 的旧会话仍绑着旧钥，必须继续用旧钥签；
// 给某 node 签名永远用该 node 登录时的那把。新钥 / 新绑定只在登录成功后提交（见 `session-pop-login`），
// 登录失败不动任何已有状态。登录侧实现在懒加载的 `session-pop-login`，不进常驻路径。

import { parseNodeIdFromPath, setRequestPopProvider, withPopParam } from '@vibeterm/api-client';
import { onAuthRequired } from '@vibeterm/api-client/auth/index';
import { setWsPopRecovery, setWsUrlSigner } from '@vibeterm/ws-client/socket-pop';
import {
  PERSISTED_POP_VERSION,
  type PersistedPopNode,
  type PersistedPopState,
  clearPersistedPopKey,
  loadPersistedPopKey,
  savePersistedPopKey,
} from './session-key-persistence';

/** 服务端 node 会话的硬上限；node 绑定的钥保留到该 node 会话的硬过期。 */
export const POP_SESSION_HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CEREMONY_PATHS = new Set([
  '/api/auth/challenge',
  '/api/auth/login',
  '/api/auth/passkey/login/options',
]);

/** 节点集合变化时的回调（参数为新加入的 nodeId，移除时为 null）；返回的 Promise 会被登录流程等一下。 */
export type PopNodesListener = (addedNodeId: string | null) => Promise<void> | void;

export interface PopKeyEntry {
  key: CryptoKey;
  sessPk: Uint8Array;
  /** 在途登录对它的占用：占用期间即使还没有 node 引用也不回收。 */
  leases: number;
  /** 这把钥已提交到 IndexedDB（从盘上读回来的直接是 true）。 */
  persisted: Promise<boolean>;
}

/** 钥池：公钥十六进制 → 钥。 */
export const popKeys = new Map<string, PopKeyEntry>();
/** nodeId → 该 node 会话绑定的钥与硬过期时刻。 */
export const popNodes = new Map<string, PersistedPopNode>();
let settled = false;
let loading: Promise<void> | null = null;
/** 登出 +1：读盘或登录期间发生过登出的旧结果一律作废。 */
let epoch = 0;
const listeners = new Set<PopNodesListener>();

interface PopStorage {
  load: typeof loadPersistedPopKey;
  save: typeof savePersistedPopKey;
  clear: typeof clearPersistedPopKey;
}

let storage: PopStorage = {
  load: loadPersistedPopKey,
  save: savePersistedPopKey,
  clear: clearPersistedPopKey,
};

type AuthModule = typeof import('@vibeterm/shared/auth');
let authModule: Promise<AuthModule> | null = null;

/** 签名实现（含椭圆曲线依赖）只在真有 PoP 会话时才加载，不进常驻路径。 */
function loadAuth(): Promise<AuthModule> {
  authModule ??= import('@vibeterm/shared/auth');
  return authModule;
}

export function popEpoch(): number {
  return epoch;
}

export function notifyPopNodes(addedNodeId: string | null): Promise<unknown> {
  return Promise.allSettled(
    [...listeners].map(async (listener) => {
      await listener(addedNodeId);
    })
  );
}

export function onPopNodesChange(listener: PopNodesListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 该 node 当前绑定的钥 id（公钥十六进制）；没绑定或已过硬上限返回 null。只读，不触发加载。 */
export function popBindingKeyId(nodeId: string): string | null {
  const bound = popNodes.get(nodeId);
  return bound && bound.expiresAt > Date.now() ? bound.pk : null;
}

/** 与 `popKeys` 下标同一格式；登录 chunk 里的 `popKeyId` 同义，这里留一份免得常驻路径去拉它。 */
export function sessionPopKeyId(sessPk: Uint8Array): string {
  return Array.from(sessPk, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 持有 PoP 会话且未过硬上限的 node。 */
export function popNodeIds(): string[] {
  return [...popNodes.keys()].filter(isPopNode);
}

function isPopNode(nodeId: string): boolean {
  const bound = popNodes.get(nodeId);
  return bound !== undefined && bound.expiresAt > Date.now() && popKeys.has(bound.pk);
}

/** 钥池与绑定落盘；没有任何钥就直接删记录。 */
export function persistPopState(): Promise<boolean> {
  if (popKeys.size === 0) return storage.clear();
  const record: PersistedPopState = {
    version: PERSISTED_POP_VERSION,
    keys: Object.fromEntries(
      [...popKeys].map(([id, { key, sessPk }]) => [
        id,
        { privateKey: key, sessPk: new Uint8Array(sessPk) },
      ])
    ),
    nodes: Object.fromEntries(popNodes),
  };
  return storage.save(record);
}

/** 回收没有任何 node 引用、也没有在途登录占用的钥；返回是否回收了东西（调用方负责落盘）。 */
export function dropUnusedKeys(): boolean {
  const used = new Set([...popNodes.values()].map((bound) => bound.pk));
  let changed = false;
  for (const [id, entry] of popKeys) {
    if (entry.leases === 0 && !used.has(id)) changed = popKeys.delete(id) || changed;
  }
  return changed;
}

async function readState(): Promise<void> {
  const at = epoch;
  const record = await storage.load();
  if (at !== epoch || !record) return;
  const now = Date.now();
  const live = Object.entries(record.nodes).filter(([, bound]) => bound.expiresAt > now);
  for (const [nodeId, bound] of live) {
    popNodes.set(nodeId, bound);
    if (popKeys.has(bound.pk)) continue;
    const { privateKey, sessPk } = record.keys[bound.pk] as (typeof record.keys)[string];
    popKeys.set(bound.pk, {
      key: privateKey,
      sessPk,
      leases: 0,
      persisted: Promise.resolve(true),
    });
  }
  const stale = live.length < Object.keys(record.nodes).length;
  const orphaned = Object.keys(record.keys).length > popKeys.size;
  if (stale || orphaned) void persistPopState();
}

/** 从 IndexedDB 读一次 PoP 状态；整个文档生命周期只读一次，之后共享结果。 */
export function loadPopState(): Promise<void> {
  loading ??= readState().then(() => {
    settled = true;
    return notifyPopNodes(null).then(() => undefined);
  });
  return loading;
}

/** 登出：全部钥与绑定清零，盘上删除。返回落盘删除的 Promise。 */
export function clearSessionPop(): Promise<boolean> {
  epoch += 1;
  const had = popNodes.size > 0;
  popKeys.clear();
  popNodes.clear();
  settled = true;
  loading = Promise.resolve();
  if (had) void notifyPopNodes(null);
  return storage.clear();
}

/** 某个 node 的会话没了（需要重新登录）：不再代它签名，它独占的钥一并回收。 */
function forgetNode(nodeId: string): void {
  if (!popNodes.delete(nodeId)) return;
  dropUnusedKeys();
  void persistPopState();
  void notifyPopNodes(null);
}

function currentHost(): string | null {
  return (globalThis as { location?: { host?: string } }).location?.host ?? null;
}

/** 只给本 gateway 的请求签：相对 URL、同 host 的绝对 URL；登录仪式端点不签（服务端不查）。 */
function popNodeOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://pop.invalid');
  } catch {
    return null;
  }
  if (parsed.host !== 'pop.invalid' && parsed.host !== currentHost()) return null;
  if (CEREMONY_PATHS.has(parsed.pathname)) return null;
  return parseNodeIdFromPath(parsed.pathname);
}

async function proofFor(method: string, url: string, nodeId: string): Promise<string | null> {
  const auth = await loadAuth();
  const bound = popNodes.get(nodeId);
  const signingKey = bound && popKeys.get(bound.pk)?.key;
  if (!signingKey) return null;
  return auth.signPop(
    (message) => auth.signWithWebCryptoEd25519(signingKey, message),
    auth.popTargetFromUrl(method, url)
  );
}

function signRequest(method: string, url: string): Promise<string | null> | null {
  const nodeId = popNodeOf(url);
  if (nodeId === null) return null;
  if (settled && !isPopNode(nodeId)) return null;
  return loadPopState().then(() => (isPopNode(nodeId) ? proofFor(method, url, nodeId) : null));
}

function signWsUrl(url: string): Promise<string> | null {
  const pending = signRequest('GET', url);
  if (!pending) return null;
  return pending.then((proof) => (proof === null ? url : withPopParam(url, proof)));
}

function canSignFor(url: string): boolean {
  const nodeId = popNodeOf(url);
  if (nodeId === null) return false;
  return !settled || isPopNode(nodeId);
}

let authListenerInstalled = false;

/** 把签名挂到 `ApiClient` 与浏览器 WS 打开处；幂等。 */
export function installSessionPop(): void {
  setRequestPopProvider({ sign: signRequest, canSign: canSignFor });
  setWsUrlSigner(signWsUrl);
  setWsPopRecovery(canSignFor);
  if (authListenerInstalled) return;
  authListenerInstalled = true;
  onAuthRequired((detail) => forgetNode(detail.nodeId));
}

/** 仅测试使用：丢弃内存状态，不碰盘，模拟「换了一个 document」。 */
export function resetSessionPopForTest(): void {
  epoch += 1;
  popKeys.clear();
  popNodes.clear();
  settled = false;
  loading = null;
}

/** 仅测试使用：换掉落盘实现（bun 里没有 IndexedDB），不传则还原。 */
export function setPopStorageForTest(next?: Partial<PopStorage>): void {
  storage = {
    load: next?.load ?? loadPersistedPopKey,
    save: next?.save ?? savePersistedPopKey,
    clear: next?.clear ?? clearPersistedPopKey,
  };
}
