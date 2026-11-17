// 一次性登录命令的 HTTP 契约（每台节点本地接口，均属登录前公开面，经入口 `/n/<id>/` 转发时不带凭据）。
// 编码与派生见 `@vibeterm/shared/auth` 的 login-code.ts。

export const LOGIN_CODE_PATH = '/api/auth/login-code';
export const LOGIN_CODE_REDEEM_PATH = '/api/auth/login-code/redeem';
export const LOGIN_CODE_STATUS_PATH = '/api/auth/login-code/status';
export const LOGIN_CODE_REVOKE_PATH = '/api/auth/login-code/revoke';

/** `POST /api/auth/challenge` 的 `purpose`：签发登录命令用的 challenge 与登录 challenge 互不通用。 */
export const LOGIN_CODE_CHALLENGE_PURPOSE = 'login-code';

/**
 * `POST /api/auth/login-code`：与 `POST /api/auth/login` 同一个信封（login / sig / delegation /
 * delegation_sig / totp? / passkey?），校验链完全相同，成功后不发会话，而是登记一个待兑换的码。
 */
export interface LoginCodeIssueRequest {
  login: string;
  sig: string;
  delegation: string;
  delegation_sig: string;
  totp?: { code: string; k_totp: string };
  passkey?: { credential_id: string; sig: string };
  /** b64url(sha256(节点码))，32 字节。 */
  code_hash: string;
}

export interface LoginCodeIssueResponse {
  expires_at: number;
}

/** `POST /api/auth/login-code/redeem`：成功时与登录一样经 set-session 头下发该节点的会话。 */
export interface LoginCodeRedeemRequest {
  /** b64url(节点码)，32 字节。 */
  code: string;
  /** CLI 本机生成的会话公钥（b64url 32 字节），会话按它做持有证明。 */
  sess_pk: string;
  pop?: boolean;
}

export interface LoginCodeRedeemResponse {
  expires_at: number;
  uid: string;
  username: string | null;
}

export type LoginCodeState = 'pending' | 'used' | 'expired' | 'revoked';

/** `status` / `revoke` 的请求体：持码人查询或作废自己的码。 */
export interface LoginCodeLookupRequest {
  code: string;
}

export interface LoginCodeStatusResponse {
  state: LoginCodeState;
  expires_at: number;
  used_at: number | null;
}

/** 登录命令相关的失败码（HTTP 体 `{ code }`）。登录校验链本身的失败码与 `/api/auth/login` 相同。 */
export const LOGIN_CODE_ERRORS = {
  /** 码不存在或格式不对。 */
  invalid: 'LOGIN_CODE_INVALID',
  used: 'LOGIN_CODE_USED',
  expired: 'LOGIN_CODE_EXPIRED',
  revoked: 'LOGIN_CODE_REVOKED',
  /** 该用户在本节点待兑换的码已达上限。 */
  limit: 'LOGIN_CODE_LIMIT',
  /** 既没有本次新校验的验证码，委托也不是刚签的：需要现场输入验证码、通行密钥或密码。 */
  stepUpRequired: 'STEP_UP_REQUIRED',
  /** 该验证码在本节点已被使用过（签发登录命令要求从未用过的验证码）。 */
  totpUsed: 'TOTP_ALREADY_USED',
} as const;

export type LoginCodeErrorCode = (typeof LOGIN_CODE_ERRORS)[keyof typeof LOGIN_CODE_ERRORS];
