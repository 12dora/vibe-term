// mesh 身份鉴权相关的 REST 报文类型（设计见 docs/hub/2026082700-hub-node-architecture.md §2 / §4）。
// 所有二进制字段一律 base64url（无 padding）字符串，与 `@tmex/shared/auth` 的 encodeBase64url 对齐。

/** `GET /api/auth/mode` 的 kdf 参数投影（salt 为 base64url）。 */
export interface AuthKdfParamsJson {
  salt: string;
  memory_kib: number;
  iterations: number;
  parallelism: number;
}

/**
 * `GET /api/auth/mode`。
 * `mode==='none'` 即 standalone，登录页整体不渲染。
 *
 * `uid` 是 **user id**，不是用户名：`login.uid`、`delegation.uid` 与 `k_totp` 的 HKDF info
 * 都必须用它（gateway `auth-routes.ts` 用 `user.id` 校验）；`username` 只用于展示与预填。
 *
 * `rootEpoch` 为派生 `k_totp` 所必需（HKDF salt 含 root_epoch）。**gateway 目前尚未返回**，
 * 缺失时按 0 退化——用户 rotate 过根钥后 TOTP 登录会失败，见结果文档「待协调」。
 */
export interface AuthModeResponse {
  mode: 'none' | 'mesh';
  nodeId: string;
  uid: string | null;
  username: string | null;
  kdfParams: AuthKdfParamsJson | null;
  passkeysForThisOrigin: boolean;
  passkeyAvailable: boolean;
  totpEnabled?: boolean;
  rootEpoch?: number;
}

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
}

export interface AuthLoginResponse {
  sid: string;
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
  | 'TOTP_REQUIRED'
  | 'TOTP_INVALID'
  | 'RATE_LIMITED'
  | (string & {});

/** `/n/:id/*` 转发链路上「该 node 未登录」的 401 报文。 */
export const NODE_LOGIN_REQUIRED = 'NODE_LOGIN_REQUIRED';

export interface NodeLoginRequiredBody {
  code: typeof NODE_LOGIN_REQUIRED;
  nodeId: string;
}

/** `GET /api/mesh/nodes` 的单行。 */
export interface MeshNode {
  id: string;
  name: string;
  /** base64url，32 字节 */
  publicKey: string;
  online: boolean;
  /** `lan` / `relay` / null（不可达） */
  reach: string | null;
  version: string | null;
  direct_capable: boolean;
  inventory?: unknown;
  loggedIn: boolean;
}

export interface MeshNodesResponse {
  nodes: MeshNode[];
}

/**
 * `GET /api/auth/keylog/head`。
 * 构造任何 `user_key_log` 记录都要 `prev_hash` 与当前 epoch，缺它前端签不出记录。
 */
export interface KeyLogHeadResponse {
  seq: number | string;
  /** base64url，32 字节；genesis 为 32 个 0 */
  hash: string;
  rootEpoch: number;
  uid: string;
}

/** `POST /api/auth/keylog` 请求体。 */
export interface KeyLogAppendRequest {
  /** base64url(borsh(KeyLogRecord)) */
  bytes: string;
  /** base64url(sig)：root=64B Ed25519；passkey=borsh(PasskeyAssertion) */
  sig: string;
}

export type KeyLogAppendResult = { ok: true } | { ok: false; code: 'KEY_LOG_FORK' | (string & {}) };

/** `GET /api/auth/passkeys`（可选端点；404 时按空列表处理）。 */
export interface PasskeySummary {
  credential_id: string;
  name: string;
  rp_id: string;
  origin: string;
  device_type?: string;
  created_at?: number;
}

// ---------------------------------------------------------------------------
// WebAuthn JSON 形态（与 @simplewebauthn 的 *JSON 类型结构一致，避免引入依赖）
// ---------------------------------------------------------------------------

export interface PublicKeyCredentialDescriptorJSON {
  id: string;
  type?: string;
  transports?: string[];
}

export interface PublicKeyCredentialCreationOptionsJSON {
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: { alg: number; type: string }[];
  timeout?: number;
  excludeCredentials?: PublicKeyCredentialDescriptorJSON[];
  authenticatorSelection?: {
    authenticatorAttachment?: string;
    residentKey?: string;
    requireResidentKey?: boolean;
    userVerification?: string;
  };
  attestation?: string;
  extensions?: Record<string, unknown>;
  /** gateway 把注册 challenge 的 id 一起下发，verify 时必须原样回传。 */
  challenge_id?: string;
}

export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: PublicKeyCredentialDescriptorJSON[];
  userVerification?: string;
  extensions?: Record<string, unknown>;
}

export interface RegistrationResponseJSON {
  id: string;
  rawId: string;
  type: string;
  authenticatorAttachment?: string;
  clientExtensionResults: Record<string, unknown>;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
    publicKeyAlgorithm?: number;
    publicKey?: string;
    authenticatorData?: string;
  };
}

export interface AuthenticationResponseJSON {
  id: string;
  rawId: string;
  type: string;
  authenticatorAttachment?: string;
  clientExtensionResults: Record<string, unknown>;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
}

/** `POST /api/auth/passkey/register/verify` 的响应：add-passkey payload 字段（二进制为 base64url）。 */
export interface PasskeyRegistrationVerified {
  credential_id: string;
  /** base64url(COSE public key) */
  public_key: string;
  rp_id: string;
  origin: string;
  counter: number;
  transports: string[];
  backup_eligible: boolean;
  backup_state: boolean;
  device_type: string;
  name?: string;
}
