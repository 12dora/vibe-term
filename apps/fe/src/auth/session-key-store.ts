// 浏览器临时钥（sk_sess）与 delegation 的持有者。
//
// 设计约束（docs/hub/2026082700-hub-node-architecture.md §2）：
//   * sk_sess 的**私钥字节**永远不出 WebCrypto：能生成不可导出 CryptoKey 时会话钥可以跨文档
//     持久化（见 `./session-key-persistence`），否则退回 `@noble` 原始私钥并**只留内存**。
//   * k_totp 与一次性 TOTP 码在任何形态下都只在内存，绝不写盘、不写 localStorage / cookie。
//   * seed（= 根钥私钥）在派生出根钥与 k_totp 之后立即清零，根钥对象随即丢弃。
//   * sk_sess 只能签 login，不得签任何 user_key_log 记录。
//   * TOTP 只在 delegation.method === 'root' 且用户开了 TOTP 时随登录下发。
//
// 这里只有常驻的状态，**不 import argon2 / 椭圆曲线**；建立会话与签名的实现在
// `./session-login`，由 `ensureNodeLogin()` 在真的要登录时才 `import()` 进来。

import { markLoggedIn } from '@/node/mesh-nodes';
import type { AuthApi, MeshNode } from '@tmex/api-client/auth/index';
import type { Delegation } from '@tmex/shared/auth';
import {
  PERSISTED_SESSION_VERSION,
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
} from './session-key-persistence';

type SessionKeyMethod = 'root' | 'passkey';

/** 对外可见的会话钥元数据（不含任何私钥字节）。 */
export interface SessionKeyInfo {
  uid: string;
  /** 当前 entry 的 nodeId，写进 `login.entry`。 */
  entryNodeId: string;
  method: SessionKeyMethod;
  issuedAt: number;
  expiresAt: number;
  hasTotp: boolean;
  credentialId: string | null;
}

export interface SessionKeySecrets {
  info: SessionKeyInfo;
  /** WebCrypto 路径的不可导出私钥；回退到 `@noble` 时为 `null`。 */
  sessKey: CryptoKey | null;
  /** `@noble` 回退路径的原始私钥（只在内存，用完清零）；WebCrypto 路径为 `null`。 */
  sessSk: Uint8Array | null;
  sessPk: Uint8Array;
  delegation: Delegation;
  delegationBytes: Uint8Array;
  delegationSig: Uint8Array;
  kTotp: Uint8Array | null;
  totpCode: string | null;
}

export type LoginFailureCode =
  | 'NO_SESSION_KEY'
  | 'UNKNOWN_NODE'
  | 'NODE_PK_MISMATCH'
  | 'TOTP_REQUIRED'
  | 'NETWORK_ERROR'
  /** entry 已登录，但随后的 `/api/mesh/nodes` 拉不到——会话没法核对，不能当成登录完成。 */
  | 'NODE_LIST_FAILED'
  | (string & {});

export type LoginNodeResult = { ok: true } | { ok: false; code: LoginFailureCode };

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let current: SessionKeySecrets | null = null;

/**
 * 这一份文档有没有做过「从 IndexedDB 恢复」。
 *
 * `null` = 还没试过；一旦试过（或被 `clearSessionKey()` 显式否定）就锁住结果，
 * 登出之后不会被下一次 `ensureNodeLogin()` 又从盘上捞回来。
 */
let restorePromise: Promise<SessionKeyInfo | null> | null = null;

/** 每次登录 / 登出 +1：读盘期间发生过状态变化时，旧记录一律作废。 */
let generation = 0;

/** 命令式读取：顺带清掉已过期的会话钥。**不**触发恢复，只反映此刻内存里有什么。 */
export function getSessionKey(): SessionKeyInfo | null {
  if (!current) return null;
  if (Date.now() >= current.info.expiresAt) {
    void clearSessionKey();
    return null;
  }
  return current.info;
}

export function hasSessionKey(): boolean {
  return getSessionKey() !== null;
}

/**
 * 登出 / 换密码 / 会话过期：内存**同步**清零，盘上那份异步删掉。
 *
 * 返回删除的 Promise：删除没提交就跳转 / 刷新，新 document 会把这份仍然有效的 delegation 恢复
 * 出来，登出等于没发生。所以真正的登出路径必须 `await` 它再离开页面；别的地方（同步的
 * `getSessionKey()` 过期清理等）不 await 也没关系。
 */
export function clearSessionKey(): Promise<boolean> {
  generation += 1;
  restorePromise = Promise.resolve(null);
  const cleared = clearPersistedSession();
  if (current) {
    current.sessSk?.fill(0);
    current.delegationSig.fill(0);
    current.kTotp?.fill(0);
    current.totpCode = null;
    current = null;
  }
  return cleared;
}

/**
 * 跨文档恢复会话钥：PWA 冷启动 / 刷新后内存是空的，但 IndexedDB 里可能还有一份未过期的
 * 不可导出会话钥。整个文档生命周期内只真正读一次盘，之后共享同一个结果。
 *
 * 恢复是异步的，而 `hasSessionKey()` 是同步的——所有「要不要退回登录页」的判断都必须先 await
 * 这个函数（`ensureNodeLogin()` 已经代劳），否则冷启动的第一帧会误判成没有会话钥。
 */
export function restoreSessionKey(): Promise<SessionKeyInfo | null> {
  const live = getSessionKey();
  if (live) return Promise.resolve(live);
  if (!restorePromise) restorePromise = readPersistedSession();
  return restorePromise;
}

async function readPersistedSession(): Promise<SessionKeyInfo | null> {
  const at = generation;
  const record = await loadPersistedSession();
  // 读盘期间登录 / 登出过：以那次为准，绝不用一份旧记录把它覆盖掉。
  if (at !== generation) return getSessionKey();
  if (!record) return null;
  if (Date.now() >= record.info.expiresAt) {
    await clearPersistedSession();
    return null;
  }
  // 恢复出来的会话没有 k_totp / 一次性码：开了 TOTP 的密码会话本来就不持久化（见下）。
  current = {
    info: record.info,
    sessKey: record.privateKey,
    sessSk: null,
    sessPk: record.sessPk,
    delegation: record.delegation,
    delegationBytes: record.delegationBytes,
    delegationSig: record.delegationSig,
    kTotp: null,
    totpCode: null,
  };
  return record.info;
}

/** fan-out 结束后清掉一次性的 TOTP 码；k_totp 保留供后续新 node 登录时配合新码使用。 */
export function clearTotpCode(): void {
  if (current) current.totpCode = null;
}

export function setTotpCode(code: string): void {
  if (current) current.totpCode = code;
}

/** 仅供 `./session-login` 读内存里的私钥材料。 */
export function readSessionSecrets(): SessionKeySecrets | null {
  return current;
}

/**
 * 接管一份新会话的所有权：旧会话就地清零，之后由 `clearSessionKey()` 负责清零新的。
 *
 * 满足两个条件才写盘：私钥是不可导出的 `CryptoKey`（没有任何密钥字节会落盘），且这不是
 * 开了 TOTP 的密码会话——那种会话每次登录 node 都要一个新的一次性码，而码与 k_totp 都不
 * 持久化，存下来也只会稳定返回 `TOTP_REQUIRED`，不如维持今天的「回登录页当场输码」。
 */
export function adoptSessionSecrets(secrets: SessionKeySecrets): SessionKeyInfo {
  // 删旧记录与写新记录都排在同一条持久化队列上，先删后写的顺序有保证。
  void clearSessionKey();
  current = secrets;
  restorePromise = Promise.resolve(secrets.info);
  if (secrets.sessKey && !secrets.info.hasTotp) {
    void savePersistedSession({
      version: PERSISTED_SESSION_VERSION,
      info: secrets.info,
      privateKey: secrets.sessKey,
      // 都拷一份再交给 IndexedDB：写事务是异步的，而下一次 `clearSessionKey()` 会就地清零。
      sessPk: new Uint8Array(secrets.sessPk),
      delegation: secrets.delegation,
      delegationBytes: new Uint8Array(secrets.delegationBytes),
      delegationSig: new Uint8Array(secrets.delegationSig),
    });
  }
  return secrets.info;
}

/** 就地清零一份不再使用的会话材料（`clearSessionKey()` 对 `current` 做的那套）。 */
function wipeSecrets(secrets: SessionKeySecrets): void {
  secrets.sessSk?.fill(0);
  secrets.delegationSig.fill(0);
  secrets.kTotp?.fill(0);
  secrets.totpCode = null;
}

/**
 * 两阶段会话替换：常规改密后要用新密码重建 delegation 并重新登录 entry，但**旧会话没有被
 * 服务端撤销**——新登录只要没成功，用户就该继续用手上这一份，而不是被踢回登录页。
 *
 * 因此 `run()` 期间旧会话只是被摘下（不清零、不进 IndexedDB），只有 `accept(value)` 为真才
 * 真正丢弃它；返回值被拒或 `run()` 抛异常时，旧会话原样装回（顺带清零那份没用上的新会话）。
 *
 * 这段窗口里 `getSessionKey()` 读到 null——调用方要在进入之前取好 `entryNodeId` 之类的信息。
 */
export async function replaceSessionKey<T>(
  run: () => Promise<T>,
  accept: (value: T) => boolean
): Promise<T> {
  const previous = current;
  current = null;
  generation += 1;
  restorePromise = Promise.resolve(null);
  let keep = false;
  try {
    const value = await run();
    keep = accept(value);
    return value;
  } finally {
    if (keep) {
      if (previous) wipeSecrets(previous);
    } else if (previous) {
      // adopt 会先把 `run()` 留下的那份新会话清零，再把旧会话重新写回内存与 IndexedDB。
      adoptSessionSecrets(previous);
    } else {
      await clearSessionKey();
    }
  }
}

// ---------------------------------------------------------------------------
// 按需的单 node 登录
// ---------------------------------------------------------------------------

interface EnsureNodeLoginOptions {
  api?: AuthApi;
  /** 已知的 node 行，省掉 `loginToNode` 内部再拉一次 `/api/mesh/nodes`。 */
  node?: MeshNode;
}

/** 每个 node 同时只允许一次登录请求在途，重复调用共享同一个 Promise。 */
const nodeLoginsInFlight = new Map<string, Promise<LoginNodeResult>>();

type LoginModule = {
  loginToNode: (nodeId: string, opts: EnsureNodeLoginOptions) => Promise<LoginNodeResult>;
};

let loadLogin: () => Promise<LoginModule> = () => import('./session-login');

/**
 * 按需登录某台 node：会话钥还在（内存里，或能从 IndexedDB 恢复）就静默完成，成功后就地把
 * mesh 列表里那一行标成已登录。
 *
 * 幂等靠两点：同一 nodeId 的并发调用共享在途 Promise；成功后 mesh store 的 `loggedIn` 立刻
 * 变 true，调用方（侧边栏 / 路由边界 / 设备页）据此不再触发。
 *
 * **先 await 一次 `restoreSessionKey()`**：PWA 冷启动的第一帧内存里什么都没有，同步判空会把
 * 每台远端 node 都判成 `NO_SESSION_KEY`。恢复不出来才返回 `NO_SESSION_KEY`（此时一个请求都
 * 不发、也不加载签名实现），由调用方退回「登录此节点」按钮 → `/login?node=`。
 *
 * 开了 TOTP 的密码会话：node 端每次登录都要校验一次 TOTP，而浏览器只持有 k_totp、生成不了
 * 新码，所以这里会返回 `TOTP_REQUIRED`，同样退回登录页让用户当场输码。
 */
export function ensureNodeLogin(
  nodeId: string,
  opts: EnsureNodeLoginOptions = {}
): Promise<LoginNodeResult> {
  const existing = nodeLoginsInFlight.get(nodeId);
  if (existing) return existing;

  const task = restoreSessionKey()
    .then(async (session): Promise<LoginNodeResult> => {
      if (!session) return { ok: false, code: 'NO_SESSION_KEY' };
      const mod = await loadLogin();
      const result = await mod.loginToNode(nodeId, opts);
      if (result.ok) markLoggedIn(nodeId);
      return result;
    })
    // chunk 拉不下来（离线 / 部署换了 hash）也得给调用方一个结果，否则门闸永远停在 pending。
    .catch((): LoginNodeResult => ({ ok: false, code: 'NETWORK_ERROR' }))
    .finally(() => {
      nodeLoginsInFlight.delete(nodeId);
    });
  nodeLoginsInFlight.set(nodeId, task);
  return task;
}

/** 仅测试使用：丢弃在途的单 node 登录与恢复结果，避免用例之间互相串。 */
export function resetNodeLoginsForTest(): void {
  nodeLoginsInFlight.clear();
  restorePromise = null;
}

/**
 * 仅测试使用：模拟「PWA 冷启动，换了一个 document」——内存态全丢，但 IndexedDB 里的记录留着。
 * 与 `clearSessionKey()` 的区别正在于此：那是登出，会连盘上那份一起删。
 */
export function resetSessionMemoryForTest(): void {
  current = null;
  restorePromise = null;
  generation += 1;
}

/** 仅测试使用：替换登录实现的加载器，不传则还原成真的 `import('./session-login')`。 */
export function setLoginLoaderForTest(loader?: () => Promise<LoginModule>): void {
  loadLogin = loader ?? (() => import('./session-login'));
}
