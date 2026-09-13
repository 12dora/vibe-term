/** `POST /n/:T/api/auth/challenge` 响应。 */
export interface AuthChallengeResponse {
  challenge_id: string;
  /** base64url，32 字节 */
  nonce: string;
  /** base64url，32 字节：目标 node 的 Ed25519 公钥 */
  nodePk: string;
}

/** `POST /n/:T/api/auth/login` 请求体。 */
export interface AuthLoginRequest {
  /** base64url(borsh(Login)) */
  login: string;
  /** base64url(sig)，由 sk_sess 签 */
  sig: string;
  /** base64url(borsh(Delegation)) */
  delegation: string;
  /**
   * base64url。method=root 时为 64 字节 Ed25519 签名；
   * method=passkey 时为 borsh(PasskeyAssertion)。
   */
  delegation_sig: string;
  totp?: {
    code: string;
    /** base64url，32 字节 */
    k_totp: string;
  };
  /**
   * 密码登录的通行密钥二次验证（method=root 且用户已注册通行密钥时必填）。
   * 断言的 WebAuthn challenge 固定为 `sha256(borsh(Delegation))`（与 passkey 直接登录相同），
   * 因此同一份断言可随 delegation 复用于所有 node 的登录，直到 delegation 过期。
   */
  passkey?: {
    /** base64url 的 credential id */
    credential_id: string;
    /** base64url(borsh(PasskeyAssertion)) */
    sig: string;
  };
}

/**
 * 登录成功体**只有** `expires_at`（B2-2b-fix 契约）：sid 走内部 set-session 头，
 * 由 entry 转成 `Set-Cookie` 后删除，浏览器永远拿不到。
 */
export interface AuthLoginResponse {
  expires_at: number;
}

/** 登录失败时后端返回的 `{code}`。 */
export type AuthLoginErrorCode =
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_MISMATCH'
  | 'TARGET_MISMATCH'
  | 'UID_MISMATCH'
  | 'ENTRY_MISMATCH'
  | 'BAD_SIGNATURE'
  | 'BAD_DELEGATION'
  /** 账号不存在 / 密码错误 / 会话签名错误统一为这一个码（不区分原因）。 */
  | 'INVALID_CREDENTIALS'
  | 'TOTP_REQUIRED'
  | 'TOTP_INVALID'
  /** 用户已注册通行密钥但本次密码登录未附带 `passkey` 二次验证。 */
  | 'PASSKEY_REQUIRED'
  /** 附带的通行密钥断言校验失败（凭证不属于该用户 / 签名错 / 计数器回退）。 */
  | 'PASSKEY_INVALID'
  | 'RATE_LIMITED'
  | (string & {});

/** `/n/:id/*` 转发链路上「该 node 未登录」的 401 报文。 */
export const NODE_LOGIN_REQUIRED = 'NODE_LOGIN_REQUIRED';
