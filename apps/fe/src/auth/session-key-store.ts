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
  /**
   * 密码登录的通行密钥二次验证：断言绑定的凭证 id 与 borsh(PasskeyAssertion) 字节。
   * 断言的 challenge 是 `sha256(borsh(delegation))`，与 delegation 同寿命，因此同一份可以
   * 复用于所有 node 的登录；没有二次验证时两者都为 null。
   */
  passkeyCredentialId: string | null;
  passkeySig: Uint8Array | null;
  kTotp: Uint8Array | null;
  totpCode: string | null;
}

export type LoginFailureCode =
  | 'NO_SESSION_KEY'
  | 'UNKNOWN_NODE'
  | 'NODE_PK_MISMATCH'
  | 'TOTP_REQUIRED'
  /** 用户已注册通行密钥，但这次登录没带二次验证断言（且当前调用不允许当场做仪式）。 */
  | 'PASSKEY_REQUIRED'
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

/**
 * 两阶段替换的令牌。进行中时 `adoptSessionSecrets()` 只换内存、不碰 IndexedDB；
 * 期间只要有人调 `clearSessionKey()`（用户登出，或 `loginSelf()` 撞上 NODE_PK_MISMATCH
 * 主动丢弃会话），整次替换即作废，新旧两份都不留。
 *
 * `previous` 是被摘下来的旧会话，`settled` 在这次替换落定（新会话被接受 / 旧会话装回 /
 * 整体作废）之后 resolve，供「要不要退回登录页」这类判断等它一等。
 */
interface ReplacementToken {
  cancelled: boolean;
  previous: SessionKeySecrets | null;
  settled: Promise<void>;
}

let pendingReplacement: ReplacementToken | null = null;

/**
 * 替换窗口里对外该报的会话：旧那份。
 *
 * 盘上留着的、刷新一下能恢复出来的、服务端也没撤销的，都还是它——所以这段窗口里
 * 「用户还登录着吗」的答案必须是「是」。被 `clearSessionKey()` 作废之后除外：那是
 * 明确的登出，两份都不算数了。
 *
 * 只有 `getSessionKey()` 这类**只读元数据**的入口走这条回退；`readSessionSecrets()`
 * 绝不回退，否则替换期间的签名会用上旧 delegation。
 */
function replacedSessionInfo(): SessionKeyInfo | null {
  const previous = pendingReplacement?.cancelled === false ? pendingReplacement.previous : null;
  if (!previous) return null;
  // 过期了只当没有，**不**在这里 `clearSessionKey()`：那会把正在进行的替换一起作废。
  return Date.now() >= previous.info.expiresAt ? null : previous.info;
}

/** 命令式读取：顺带清掉已过期的会话钥。**不**触发恢复，只反映此刻内存里有什么。 */
export function getSessionKey(): SessionKeyInfo | null {
  if (!current) return replacedSessionInfo();
  if (Date.now() >= current.info.expiresAt) {
    void clearSessionKey();
    return null;
  }
  return current.info;
}

export function hasSessionKey(): boolean {
  return getSessionKey() !== null;
}

/** 两阶段会话替换是否正在进行（见 `replaceSessionKey()`）。 */
export function isSessionReplacementPending(): boolean {
  return pendingReplacement !== null;
}

/** 等在进行中的替换落定；没有进行中的替换时立刻 resolve。 */
export function whenSessionReplacementSettled(): Promise<void> {
  return pendingReplacement?.settled ?? Promise.resolve();
}

/**
 * 登出 / 换密码 / 会话过期：内存**同步**清零，盘上那份异步删掉。
 *
 * 返回删除的 Promise：删除没提交就跳转 / 刷新，新 document 会把这份仍然有效的 delegation 恢复
 * 出来，登出等于没发生。所以真正的登出路径必须 `await` 它再离开页面；别的地方（同步的
 * `getSessionKey()` 过期清理等）不 await 也没关系。
 */
export function clearSessionKey(): Promise<boolean> {
  if (pendingReplacement) pendingReplacement.cancelled = true;
  generation += 1;
  restorePromise = Promise.resolve(null);
  const cleared = clearPersistedSession();
  if (current) {
    current.sessSk?.fill(0);
    current.delegationSig.fill(0);
    current.passkeySig?.fill(0);
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
    // 旧记录（这个字段出现之前存的）没有这两项，按「没有二次验证」恢复即可。
    passkeyCredentialId: record.passkeyCredentialId ?? null,
    passkeySig: record.passkeySig ?? null,
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

/**
 * 把刚做完的通行密钥二次验证断言挂到当前会话上，并落盘。
 *
 * 服务端在 mode 快照过期时会回 `PASSKEY_REQUIRED`，此时会话钥本身没问题，补一次仪式即可；
 * 断言与 delegation 同寿命，存下来之后其余 node 的登录都能静默复用它。
 */
export function setPasskeyAssertion(credentialId: string, sig: Uint8Array): void {
  if (!current) return;
  current.passkeySig?.fill(0);
  current.passkeyCredentialId = credentialId;
  current.passkeySig = sig;
  if (!pendingReplacement) void persistSession(current);
}

/**
 * 丢掉这份被判为无效的断言，**但保留会话钥**。
 *
 * 断言与 delegation 绑死，服务端说它不认，重发多少次都是同一个结果——所以必须丢。但会话钥本身
 * 没有任何问题：丢掉断言之后，下一次登录退化成不带二次验证，服务端会回 `PASSKEY_REQUIRED`，
 * 用户主动发起的那次登录当场补一次仪式即可，**连密码都不用重输**。
 *
 * 返回落盘的 Promise：盘上那份也必须一起改掉，否则刷新一下这把已被拒的断言又回来了。
 */
export function clearPasskeyAssertion(): Promise<boolean> {
  if (!current || (!current.passkeyCredentialId && !current.passkeySig)) {
    return Promise.resolve(true);
  }
  current.passkeySig?.fill(0);
  current.passkeyCredentialId = null;
  current.passkeySig = null;
  // 两阶段替换期间一个字节都不写盘，由 `replaceSessionKey()` 在接受之后统一提交。
  if (pendingReplacement) return Promise.resolve(true);
  return persistSession(current);
}

/** 仅供 `./session-login` 读内存里的私钥材料。 */
export function readSessionSecrets(): SessionKeySecrets | null {
  return current;
}

/**
 * 把这份会话变成盘上唯一那条记录。
 *
 * 满足两个条件才写：私钥是不可导出的 `CryptoKey`（没有任何密钥字节会落盘），且这不是
 * 开了 TOTP 的密码会话——那种会话每次登录 node 都要一个新的一次性码，而码与 k_totp 都不
 * 持久化，存下来也只会稳定返回 `TOTP_REQUIRED`，不如维持今天的「回登录页当场输码」。
 * 不满足就把旧记录删掉：盘上绝不能留一条与内存里这份不是同一个会话的记录。
 *
 * 写走**一次 `put`**（同一个 key 覆盖），不再「先删后写」——那两个事务之间存在一个盘上
 * 什么都没有的窗口，此刻刷新页面就等于莫名其妙登出一次。
 */
function persistSession(secrets: SessionKeySecrets): Promise<boolean> {
  if (!secrets.sessKey || secrets.info.hasTotp) return clearPersistedSession();
  return savePersistedSession({
    version: PERSISTED_SESSION_VERSION,
    info: secrets.info,
    privateKey: secrets.sessKey,
    // 都拷一份再交给 IndexedDB：写事务是异步的，而下一次清零会就地改这几个数组。
    sessPk: new Uint8Array(secrets.sessPk),
    delegation: secrets.delegation,
    delegationBytes: new Uint8Array(secrets.delegationBytes),
    delegationSig: new Uint8Array(secrets.delegationSig),
    // 断言是签名不是密钥：存下来才能让别的 node 静默登录，不必再弹一次系统仪式。
    passkeyCredentialId: secrets.passkeyCredentialId,
    passkeySig: secrets.passkeySig ? new Uint8Array(secrets.passkeySig) : null,
  });
}

/**
 * 接管一份新会话的所有权：旧会话就地清零，之后由 `clearSessionKey()` 负责清零新的。
 *
 * 两阶段替换（`replaceSessionKey()`）期间**一个字节都不写盘**：那时新会话还没被接受，
 * 盘上必须原样留着旧那条，由 `replaceSessionKey()` 在接受之后统一提交。
 */
export function adoptSessionSecrets(secrets: SessionKeySecrets): SessionKeyInfo {
  generation += 1;
  if (current) wipeSecrets(current);
  current = secrets;
  restorePromise = Promise.resolve(secrets.info);
  if (!pendingReplacement) void persistSession(secrets);
  return secrets.info;
}

/** 就地清零一份不再使用的会话材料（`clearSessionKey()` 对 `current` 做的那套）。 */
function wipeSecrets(secrets: SessionKeySecrets): void {
  secrets.sessSk?.fill(0);
  secrets.delegationSig.fill(0);
  secrets.passkeySig?.fill(0);
  secrets.kTotp?.fill(0);
  secrets.totpCode = null;
}

/**
 * 两阶段会话替换：常规改密后要用新密码重建 delegation 并重新登录 entry，但**旧会话没有被
 * 服务端撤销**——新登录只要没成功，用户就该继续用手上这一份，而不是被踢回登录页。
 *
 * 因此 `run()` 期间旧会话只是从内存里被摘下，**持久化层完全不动**：盘上那条旧记录一直在，
 * 直到 `accept(value)` 为真才被新会话一次性覆盖。这段窗口里刷新 / 冷启动，恢复出来的仍然是
 * 旧会话（新的那份根本没落过盘）；返回值被拒或 `run()` 抛异常时，旧会话原样装回内存，盘上
 * 那条从头到尾没被碰过。
 *
 * 这段窗口里 `readSessionSecrets()` 读到 null（新会话还没建出来之前），调用方要在进入之前
 * 取好 `entryNodeId` 之类的信息；而 `getSessionKey()` / `hasSessionKey()` 仍然报旧会话——
 * 盘上那条还在，用户并没有登出，路由守卫不该在这段窗口里把人踢去登录页。
 */
export async function replaceSessionKey<T>(
  run: () => Promise<T>,
  accept: (value: T) => boolean
): Promise<T> {
  const previous = current;
  let markSettled = (): void => undefined;
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  const token: ReplacementToken = { cancelled: false, previous, settled };
  current = null;
  generation += 1;
  restorePromise = Promise.resolve(null);
  pendingReplacement = token;
  let keep = false;
  try {
    const value = await run();
    keep = accept(value);
    return value;
  } finally {
    pendingReplacement = null;
    try {
      await settleReplacement(token, previous, keep);
    } finally {
      markSettled();
    }
  }
}

async function settleReplacement(
  token: { cancelled: boolean },
  previous: SessionKeySecrets | null,
  keep: boolean
): Promise<void> {
  const replacement = current;
  // 替换期间会话被作废（登出 / entry 公钥对不上）：盘上那条已由 `clearSessionKey()` 删掉，
  // 新旧两份一起丢弃，绝不把旧会话又装回去。
  if (token.cancelled) {
    if (previous) wipeSecrets(previous);
    if (replacement) wipeSecrets(replacement);
    current = null;
    restorePromise = Promise.resolve(null);
    return;
  }
  if (keep && replacement) {
    if (previous) wipeSecrets(previous);
    // 到这一刻盘上都还是旧那条；新会话被接受了，才用一次 put 把它换掉。
    await persistSession(replacement);
    return;
  }
  if (replacement) wipeSecrets(replacement);
  current = previous;
  generation += 1;
  // 没有旧会话可装回时把恢复结果解锁：盘上那条（如果有）本来就没被动过，
  // 下一次 `restoreSessionKey()` 该照常去读它，而不是被这次失败的替换锁成 null。
  restorePromise = previous ? Promise.resolve(previous.info) : null;
}

// ---------------------------------------------------------------------------
// 按需的单 node 登录
// ---------------------------------------------------------------------------

interface EnsureNodeLoginOptions {
  api?: AuthApi;
  /** 已知的 node 行，省掉 `loginToNode` 内部再拉一次 `/api/mesh/nodes`。 */
  node?: MeshNode;
  /**
   * 允许在服务端回 `PASSKEY_REQUIRED` 时当场做一次通行密钥仪式再重试。
   * 只有**用户主动发起**的登录能给 true——后台静默登录弹系统仪式是惊吓，不是功能。
   */
  allowPasskeyPrompt?: boolean;
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
 *
 * `PASSKEY_INVALID` 会就地把那份断言丢掉（`clearPasskeyAssertion()`），但**不丢会话钥**：
 * 断言与 delegation 绑死，被判无效后重发是可证明无用的；而会话钥本身没问题，丢掉断言之后
 * 下一次登录退化成不带二次验证，服务端回 `PASSKEY_REQUIRED`，用户点一次「登录此节点」就能
 * 当场补仪式，密码都不用重输。
 *
 * **不在这里丢会话钥**是有意的：远端 node 回 `PASSKEY_INVALID` / 签名类码（`BAD_SIGNATURE`、
 * `BAD_DELEGATION`、`ROOT_KEY_MISMATCH` …）最常见的现实原因，是那台机器的密钥日志还没同步到
 * 最新 epoch，属于会自愈的临时状态。凭一台掉队的 node 的判决就把整个会话清掉，就是 1.1.8
 * 「401 即登出」那次闪断事故的形状。entry 自己的登录页另说——那里 `isCredentialFailure()`
 * 仍然把 `PASSKEY_INVALID` 当凭证失败丢钥，因为那次判决来自用户刚刚交互过的这台机器。
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
      if (result.ok) {
        markLoggedIn(nodeId);
        return result;
      }
      // 等盘上那份真的改掉再返回，否则刷新一下这把已被拒的断言又回来了。
      if (result.code === 'PASSKEY_INVALID') await clearPasskeyAssertion();
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
