// 登录失败码 → i18n key。
//
// 登录页只显示**原因**，永远不显示后端返回的原始 code / message：用户看不懂
// `DELEGATION_BAD_SIGNATURE`，而且密码路径下把「账号不存在」「密码不对」「会话签名不对」
// 分开说，等于给爆破者一个免费的用户名枚举接口——服务端已经把它们统一成
// `INVALID_CREDENTIALS`，前端也必须只给同一句中性文案。同一个码在 passkey 路径下含义完全
// 不同（那里没有密码可言），因此按方式分表。

import { WebAuthnError } from '@tmex/api-client/auth/index';

export type LoginMethod = 'password' | 'passkey';

const GENERIC = 'auth.errors.LOGIN_FAILED';

/** 密码路径唯一的凭证失败文案：不区分账号是否存在、密码错还是签名错。 */
const INVALID_CREDENTIALS = 'auth.errors.invalidCredentials';

/** 两条路径共用的码：含义与登录方式无关。 */
const SHARED: Record<string, string> = {
  TOTP_REQUIRED: 'auth.errors.TOTP_REQUIRED',
  TOTP_INVALID: 'auth.errors.TOTP_INVALID',
  TOTP_CODE_REQUIRED: 'auth.errors.TOTP_CODE_REQUIRED',
  PASSKEY_REQUIRED: 'auth.errors.PASSKEY_REQUIRED',
  NETWORK_ERROR: 'auth.errors.NETWORK_ERROR',
  RATE_LIMITED: 'auth.errors.RATE_LIMITED',
  UNKNOWN_NODE: 'auth.errors.UNKNOWN_NODE',
  NODE_PK_MISMATCH: 'auth.errors.NODE_PK_MISMATCH',
  NODE_LIST_FAILED: 'auth.login.nodeListFailed',
  NO_SESSION_KEY: 'auth.errors.NO_SESSION_KEY',
  DELEGATION_EXPIRED: 'auth.errors.DELEGATION_EXPIRED',
  DELEGATION_ISSUED_IN_FUTURE: 'auth.errors.DELEGATION_ISSUED_IN_FUTURE',
  PROTOCOL_MISMATCH: 'auth.errors.PROTOCOL_MISMATCH',
  TARGET_MISMATCH: 'auth.errors.TARGET_MISMATCH',
  ENTRY_MISMATCH: 'auth.errors.ENTRY_MISMATCH',
  CHALLENGE_EXPIRED: 'auth.errors.CHALLENGE_EXPIRED',
  CHALLENGE_CONSUMED: 'auth.errors.CHALLENGE_CONSUMED',
  CHALLENGE_MISMATCH: 'auth.errors.CHALLENGE_MISMATCH',
  KEY_LOG_FORK: 'auth.errors.KEY_LOG_FORK',
};

/**
 * 密码路径。
 *
 * 凭证类失败（含旧节点滚动升级期间仍会回的那批分因码）一律收敛到同一句中性文案；
 * 通行密钥二次验证的失败则按「这一步失败了」单独说，否则用户不知道该去解决什么。
 */
const PASSWORD_ONLY: Record<string, string> = {
  INVALID_CREDENTIALS,
  DELEGATION_BAD_SIGNATURE: INVALID_CREDENTIALS,
  BAD_SIGNATURE: INVALID_CREDENTIALS,
  ROOT_KEY_MISMATCH: INVALID_CREDENTIALS,
  BAD_DELEGATION: INVALID_CREDENTIALS,
  DELEGATION_METHOD_MISMATCH: INVALID_CREDENTIALS,
  UNKNOWN_USER: INVALID_CREDENTIALS,
  PASSKEY_INVALID: 'auth.errors.PASSKEY_VERIFY_FAILED',
  PASSKEY_VERIFY_FAILED: 'auth.errors.PASSKEY_VERIFY_FAILED',
  PASSKEY_ABORTED: 'auth.errors.PASSKEY_ABORTED',
  // 二次验证只能在已注册通行密钥的地址完成：说清楚下一步去哪儿做。
  NO_PASSKEY_FOR_ORIGIN: 'auth.login.passkeySecondFactorNotRegistered',
  PASSKEY_CREDENTIAL_UNKNOWN: 'auth.login.passkeySecondFactorNotRegistered',
};

/** passkey 路径：没有密码可言，签名类失败是仪式 / 凭证的问题。 */
const PASSKEY_ONLY: Record<string, string> = {
  DELEGATION_BAD_SIGNATURE: 'auth.errors.PASSKEY_VERIFY_FAILED',
  BAD_SIGNATURE: 'auth.errors.PASSKEY_VERIFY_FAILED',
  BAD_DELEGATION: 'auth.errors.PASSKEY_VERIFY_FAILED',
  DELEGATION_METHOD_MISMATCH: 'auth.errors.PASSKEY_VERIFY_FAILED',
  PASSKEY_VERIFY_FAILED: 'auth.errors.PASSKEY_VERIFY_FAILED',
  PASSKEY_INVALID: 'auth.errors.PASSKEY_VERIFY_FAILED',
  PASSKEY_ABORTED: 'auth.errors.PASSKEY_ABORTED',
  PASSKEY_CREDENTIAL_UNKNOWN: 'auth.errors.PASSKEY_CREDENTIAL_UNKNOWN',
  // 服务端也会在 mode 快照过期时回这个码，文案与登录页的前置提示保持同一句。
  NO_PASSKEY_FOR_ORIGIN: 'auth.login.passkeyNotRegistered',
};

/** 失败码 → i18n key；认不出的码一律落到通用文案，绝不把码本身显示出来。 */
export function loginErrorKey(code: string | undefined | null, method: LoginMethod): string {
  if (!code) return GENERIC;
  const specific = method === 'passkey' ? PASSKEY_ONLY : PASSWORD_ONLY;
  return specific[code] ?? SHARED[code] ?? GENERIC;
}

/** 抛出来的异常 → i18n key。WebAuthn 仪式异常没有业务码，按仪式结果归类。 */
export function loginErrorKeyFromException(error: unknown, method: LoginMethod): string {
  if (error instanceof WebAuthnError) {
    return error.code === 'aborted' ? 'auth.errors.PASSKEY_ABORTED' : GENERIC;
  }
  return loginErrorKey((error as { code?: string } | null)?.code, method);
}

/**
 * 这次失败是否说明**凭证本身**不可用（密码错、授权过期、账号不存在）。
 * 为真才丢弃刚建立的会话钥；网络错误 / 验证码错这类失败留着钥，用户重试即可，
 * 也不会连累后续按需登录其它 node。
 *
 * `PASSKEY_INVALID` 也算：断言的 challenge 就是这份 delegation 的哈希，一旦服务端判定它无效，
 * 同一份断言重发多少次都是同一个结果——留着这把会话钥只会让用户卡在一个永远登不上的状态。
 *
 * `PASSKEY_REQUIRED` **不在此列**：那只说明 mode 快照过期、这次少带了二次验证，
 * 会话钥本身是好的，补一次仪式就能继续用。
 */
export function isCredentialFailure(code: string | undefined | null): boolean {
  if (!code) return false;
  return (
    code === 'INVALID_CREDENTIALS' ||
    code === 'PASSKEY_INVALID' ||
    code === 'DELEGATION_BAD_SIGNATURE' ||
    code === 'BAD_SIGNATURE' ||
    code === 'ROOT_KEY_MISMATCH' ||
    code === 'BAD_DELEGATION' ||
    code === 'DELEGATION_EXPIRED' ||
    code === 'DELEGATION_METHOD_MISMATCH' ||
    code === 'UNKNOWN_USER'
  );
}
