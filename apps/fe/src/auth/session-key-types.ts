// 会话钥的对外形状：元数据、私钥材料、登录结论。纯类型，不持有任何状态，
// 便于 `./session-login`、`./session-key-persistence` 这些实现文件引用而不反向依赖 store。

import type { Delegation } from '@vibeterm/shared/auth';

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

export type LoginNodeResult =
  | { ok: true }
  /** `retryAfterMs`：限流 / 密码登录暂停时服务端给出的剩余时长。 */
  | { ok: false; code: LoginFailureCode; retryAfterMs?: number };
