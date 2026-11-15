// 会话持有证明（PoP）的浏览器侧：登录钥在整个会话（硬上限 7 天）里逐请求签名。
//
// 为什么钥要单独保存：delegation 只有 18 小时，而 node 会话 cookie 能活到 7 天硬上限，
// 钥随 delegation 一起丢掉，会话就还在、却再也签不出证明。所以这里的钥与 `session-key-store`
// 的会话记录各自独立，只在登出 / 没有任何 node 会话时才清。
//
// 只有「不可导出的 WebCrypto 钥且已落盘 IndexedDB」才在登录时声明 `pop: true`：`@noble` 回退钥只在内存，
// 刷新页面就没了，声明了只会把用户锁在会话外。

import { parseNodeIdFromPath, setRequestPopProvider, withPopParam } from '@vibeterm/api-client';
import {
  type AuthApi,
  type AuthLoginRequest,
  type LoginResult,
  onAuthRequired,
} from '@vibeterm/api-client/auth/index';
import { setWsPopRecovery, setWsUrlSigner } from '@vibeterm/ws-client/socket-pop';
import {
  PERSISTED_POP_VERSION,
  clearPersistedPopKey,
  loadPersistedPopKey,
  savePersistedPopKey,
} from './session-key-persistence';
import type { SessionKeySecrets } from './session-key-types';

/** 服务端 node 会话的硬上限；钥保留到最晚那个 node 会话的硬过期。 */
export const POP_SESSION_HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CEREMONY_PATHS = new Set([
  '/api/auth/challenge',
  '/api/auth/login',
  '/api/auth/passkey/login/options',
]);

/** 节点集合变化时的回调（参数为新加入的 nodeId，移除时为 null）；返回的 Promise 会被登录流程等一下。 */
export type PopNodesListener = (addedNodeId: string | null) => Promise<void> | void;

let key: CryptoKey | null = null;
let sessPk: Uint8Array | null = null;
/** nodeId → 该节点会话的硬过期时刻。 */
const nodes = new Map<string, number>();
let settled = false;
let loading: Promise<void> | null = null;
/** 登出 / 换钥 +1：读盘或落盘期间发生过变化的旧结果一律作废。 */
let epoch = 0;
/** 当前这把钥是否已经提交到 IndexedDB（从盘上读回来的也算）。 */
let persisted = false;
let persistInFlight: Promise<boolean> | null = null;
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

function notify(addedNodeId: string | null): Promise<unknown> {
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

/** 持有 PoP 会话且未过硬上限的 node。 */
export function popNodeIds(): string[] {
  const now = Date.now();
  return [...nodes].filter(([, expiresAt]) => expiresAt > now).map(([nodeId]) => nodeId);
}

function isPopNode(nodeId: string): boolean {
  return key !== null && (nodes.get(nodeId) ?? 0) > Date.now();
}

function snapshot() {
  if (!key || !sessPk) return null;
  return {
    version: PERSISTED_POP_VERSION,
    privateKey: key,
    sessPk: new Uint8Array(sessPk),
    nodes: Object.fromEntries(nodes),
  };
}

function persistSnapshot(): Promise<boolean> {
  const record = snapshot();
  return record ? storage.save(record) : Promise.resolve(false);
}

async function readState(): Promise<void> {
  const at = epoch;
  const record = await storage.load();
  if (at !== epoch) return;
  const now = Date.now();
  const live = record
    ? Object.entries(record.nodes).filter(([, expiresAt]) => expiresAt > now)
    : [];
  if (record && live.length > 0) {
    key = record.privateKey;
    sessPk = record.sessPk;
    nodes.clear();
    for (const [nodeId, expiresAt] of live) nodes.set(nodeId, expiresAt);
    persisted = true;
  } else if (record) {
    await storage.clear();
  }
}

/** 从 IndexedDB 读一次 PoP 状态；整个文档生命周期只读一次，之后共享结果。 */
export function loadPopState(): Promise<void> {
  loading ??= readState().then(() => {
    settled = true;
    return notify(null).then(() => undefined);
  });
  return loading;
}

function samePublicKey(a: Uint8Array | null, b: Uint8Array): boolean {
  return a !== null && a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * 保证这把钥已经落盘；返回 false 表示不能声明 `pop: true`（回退钥 / 无 IndexedDB / 写失败）。
 * 公钥不同就是换了一把钥（重新登录）：旧钥登的那批 node 会话不再由它代签，集合清空重来；
 * 公钥相同（冷启动从盘上恢复出来的是另一个 `CryptoKey` 对象）则沿用现有状态。
 */
async function persistKey(secrets: SessionKeySecrets): Promise<boolean> {
  const next = secrets.sessKey;
  if (!next) return false;
  await loadPopState();
  if (!key || !samePublicKey(sessPk, secrets.sessPk)) {
    epoch += 1;
    key = next;
    sessPk = new Uint8Array(secrets.sessPk);
    nodes.clear();
    persisted = false;
    persistInFlight = null;
  }
  if (persisted) return true;
  const at = epoch;
  persistInFlight ??= persistSnapshot().then((ok) => {
    if (at === epoch) {
      persisted = ok;
      persistInFlight = null;
    }
    return ok;
  });
  return persistInFlight;
}

async function noteNodeSession(nodeId: string, at: number): Promise<void> {
  if (key === null || at !== epoch) return;
  nodes.set(nodeId, Date.now() + POP_SESSION_HARD_TTL_MS);
  await persistSnapshot();
  await notify(nodeId);
}

/**
 * 登录某 node：钥能持久化就声明 `pop: true`，登录成功后把该 node 记为 PoP 会话
 * （此后对它的请求逐个签名、导航凭证定时续期）。
 */
export async function loginWithPop(
  api: AuthApi,
  nodeId: string,
  body: AuthLoginRequest,
  secrets: SessionKeySecrets
): Promise<LoginResult> {
  const pop = await persistKey(secrets);
  const at = epoch;
  const result = await api.login(nodeId, pop ? { ...body, pop: true } : body);
  if (pop && result.ok) await noteNodeSession(nodeId, at);
  return result;
}

/** 钥已丢失、或没有任何 node 会话了：删钥，登出同样走这里。返回落盘删除的 Promise。 */
export function clearSessionPop(): Promise<boolean> {
  epoch += 1;
  key = null;
  sessPk = null;
  persisted = false;
  persistInFlight = null;
  const had = nodes.size > 0;
  nodes.clear();
  settled = true;
  loading = Promise.resolve();
  if (had) void notify(null);
  return storage.clear();
}

/** 某个 node 的会话没了（需要重新登录）：不再代它签名；最后一个也没了就连钥一起删。 */
function forgetNode(nodeId: string): void {
  if (!nodes.delete(nodeId)) return;
  if (nodes.size === 0) {
    void clearSessionPop();
    return;
  }
  void persistSnapshot();
  void notify(null);
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

async function proofFor(method: string, url: string, at: number): Promise<string | null> {
  const auth = await loadAuth();
  const signingKey = key;
  if (!signingKey || at !== epoch) return null;
  return auth.signPop(
    (message) => auth.signWithWebCryptoEd25519(signingKey, message),
    auth.popTargetFromUrl(method, url)
  );
}

function signRequest(method: string, url: string): Promise<string | null> | null {
  const nodeId = popNodeOf(url);
  if (nodeId === null) return null;
  if (settled && !isPopNode(nodeId)) return null;
  return loadPopState().then(() => (isPopNode(nodeId) ? proofFor(method, url, epoch) : null));
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
  key = null;
  sessPk = null;
  persisted = false;
  persistInFlight = null;
  nodes.clear();
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
