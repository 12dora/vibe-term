// 浏览器临时钥（sk_sess）与 delegation 的纯内存持有者。
//
// 设计约束（docs/hub/2026082700-hub-node-architecture.md §2）：
//   * sk_sess / delegation / k_totp **只在内存**，页面关闭即失，绝不写 localStorage 或 cookie。
//   * seed（= 根钥私钥）在派生出根钥与 k_totp 之后立即清零，根钥对象随即丢弃。
//   * sk_sess 只能签 login，不得签任何 user_key_log 记录。
//   * TOTP 只在 delegation.method === 'root' 且用户开了 TOTP 时随登录下发。
//
// 这里只有常驻的状态，**不 import argon2 / 椭圆曲线**；建立会话与签名的实现在
// `./session-login`，由 `ensureNodeLogin()` 在真的要登录时才 `import()` 进来。

import { markLoggedIn } from '@/node/mesh-nodes';
import type { AuthApi, MeshNode } from '@tmex/api-client/auth/index';
import type { Delegation } from '@tmex/shared/auth';

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
  sessSk: Uint8Array;
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

/** 命令式读取：顺带清掉已过期的会话钥。 */
export function getSessionKey(): SessionKeyInfo | null {
  if (!current) return null;
  if (Date.now() >= current.info.expiresAt) {
    clearSessionKey();
    return null;
  }
  return current.info;
}

export function hasSessionKey(): boolean {
  return getSessionKey() !== null;
}

export function clearSessionKey(): void {
  if (!current) return;
  current.sessSk.fill(0);
  current.delegationSig.fill(0);
  current.kTotp?.fill(0);
  current.totpCode = null;
  current = null;
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

/** 接管一份新会话的所有权：旧会话就地清零，之后由 `clearSessionKey()` 负责清零新的。 */
export function adoptSessionSecrets(secrets: SessionKeySecrets): SessionKeyInfo {
  clearSessionKey();
  current = secrets;
  return secrets.info;
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
 * 按需登录某台 node：内存里的会话钥还在就静默完成，成功后就地把 mesh 列表里那一行标成已登录。
 *
 * 幂等靠两点：同一 nodeId 的并发调用共享在途 Promise；成功后 mesh store 的 `loggedIn` 立刻
 * 变 true，调用方（侧边栏 / 路由边界）据此不再触发。会话钥不在内存时直接返回
 * `NO_SESSION_KEY`（不加载签名实现），由调用方退回「登录此节点」按钮 → `/login?node=`。
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
  if (!hasSessionKey()) return Promise.resolve({ ok: false, code: 'NO_SESSION_KEY' });

  const task = loadLogin()
    .then((mod) => mod.loginToNode(nodeId, opts))
    .then((result) => {
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

/** 仅测试使用：丢弃在途的单 node 登录，避免用例之间互相串。 */
export function resetNodeLoginsForTest(): void {
  nodeLoginsInFlight.clear();
}

/** 仅测试使用：替换登录实现的加载器，不传则还原成真的 `import('./session-login')`。 */
export function setLoginLoaderForTest(loader?: () => Promise<LoginModule>): void {
  loadLogin = loader ?? (() => import('./session-login'));
}
