// 登录失败码 → i18n key。
//
// 登录页只显示**原因**，永远不显示后端返回的原始 code / message：用户看不懂 `DELEGATION_BAD_SIGNATURE`，
// 而它在密码路径下的唯一现实含义就是「密码不对」（后端不存在 `BAD_PASSWORD`——密码从不上送，
// 服务端只能发现派生出的根钥签名对不上）。同一个码在 passkey 路径下含义完全不同，因此按方式分表。

import { WebAuthnError } from '@tmex/api-client/auth/index';

export type LoginMethod = 'password' | 'passkey';

const GENERIC = 'auth.errors.LOGIN_FAILED';

/** 两条路径共用的码：含义与登录方式无关。 */
const SHARED: Record<string, string> = {
  TOTP_REQUIRED: 'auth.errors.TOTP_REQUIRED',
  TOTP_INVALID: 'auth.errors.TOTP_INVALID',
  TOTP_CODE_REQUIRED: 'auth.errors.TOTP_CODE_REQUIRED',
  NETWORK_ERROR: 'auth.errors.NETWORK_ERROR',
  RATE_LIMITED: 'auth.errors.RATE_LIMITED',
  UNKNOWN_USER: 'auth.errors.UNKNOWN_USER',
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

/** 密码路径：签名类失败的现实原因只有一个——密码错了。 */
const PASSWORD_ONLY: Record<string, string> = {
  DELEGATION_BAD_SIGNATURE: 'auth.errors.wrongPassword',
  BAD_SIGNATURE: 'auth.errors.wrongPassword',
  ROOT_KEY_MISMATCH: 'auth.errors.wrongPassword',
  BAD_DELEGATION: 'auth.errors.wrongPassword',
  DELEGATION_METHOD_MISMATCH: 'auth.errors.wrongPassword',
};

/** passkey 路径：没有密码可言，签名类失败是仪式 / 凭证的问题。 */
const PASSKEY_ONLY: Record<string, string> = {
  DELEGATION_BAD_SIGNATURE: 'auth.errors.PASSKEY_VERIFY_FAILED',
  BAD_SIGNATURE: 'auth.errors.PASSKEY_VERIFY_FAILED',
  BAD_DELEGATION: 'auth.errors.PASSKEY_VERIFY_FAILED',
  DELEGATION_METHOD_MISMATCH: 'auth.errors.PASSKEY_VERIFY_FAILED',
  PASSKEY_VERIFY_FAILED: 'auth.errors.PASSKEY_VERIFY_FAILED',
  PASSKEY_ABORTED: 'auth.errors.PASSKEY_ABORTED',
  PASSKEY_CREDENTIAL_UNKNOWN: 'auth.errors.PASSKEY_CREDENTIAL_UNKNOWN',
  NO_PASSKEY_FOR_ORIGIN: 'auth.errors.NO_PASSKEY_FOR_ORIGIN',
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
 */
export function isCredentialFailure(code: string | undefined | null): boolean {
  if (!code) return false;
  return (
    code === 'DELEGATION_BAD_SIGNATURE' ||
    code === 'BAD_SIGNATURE' ||
    code === 'ROOT_KEY_MISMATCH' ||
    code === 'BAD_DELEGATION' ||
    code === 'DELEGATION_EXPIRED' ||
    code === 'DELEGATION_METHOD_MISMATCH' ||
    code === 'UNKNOWN_USER'
  );
}
