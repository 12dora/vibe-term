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
 * `rootEpoch` 为派生 `k_totp` 所必需（HKDF salt 含 root_epoch），mesh 模式下**必填**：
 * 缺失时一律按协议不兼容中止，绝不退化成 0——用户 rotate 过根钥后按 0 派生会让所有 node
 * 返回 `TOTP_INVALID`，可能远程锁死账号（见 F4-1 评审 Blocker）。
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
  /** mesh 模式必填；standalone 与「没有主用户」时为 `null`。 */
  rootEpoch?: number | null;
  /** base64url，32 字节：当前根公钥。join 串第二段用它。 */
  rootPublicKey?: string | null;
  /** hub 机所在 node 的 id（本机即 hub 时为自身 id）。 */
  hubNodeId?: string | null;
  /** hub 的对外可达地址；join 命令只能用它，绝不能退化成入口 origin。 */
  hubPublicUrl?: string | null;
}

/**
 * `POST /api/auth/passkey/login/options` 的 404 `{code:'NO_PASSKEY_FOR_ORIGIN'}`（B2-8）：
 * 该 origin 下一把可用凭证都没有（用户可能存在，但凭证都注册在别的 origin）。
 *
 * 这是**业务结果不是网络错误**：调用方必须据此提示「本入口没有可用 passkey」，
 * 绝不能回退到未过滤的凭证列表或盲取第一把。
 */
export class NoPasskeyForOriginError extends Error {
  readonly code = 'NO_PASSKEY_FOR_ORIGIN';
  constructor() {
    super('no passkey registered for this origin');
    this.name = 'NoPasskeyForOriginError';
  }
}

/** mesh 模式下缺少协议必备字段（如 `rootEpoch`）。 */
export class ProtocolMismatchError extends Error {
  readonly code = 'PROTOCOL_MISMATCH';
  constructor(readonly field: string) {
    super(`auth protocol mismatch: missing ${field}`);
    this.name = 'ProtocolMismatchError';
  }
}

/**
 * mesh 模式下读取 `rootEpoch`：缺失即协议不兼容，抛错中止。
 * **绝不允许**返回默认值 0。
 */
export function requireRootEpoch(mode: Pick<AuthModeResponse, 'rootEpoch'>): number {
  const epoch = mode.rootEpoch;
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0) {
    throw new ProtocolMismatchError('rootEpoch');
  }
  return epoch;
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

/**
 * 登录成功体**只有** `expires_at`（B2-2b-fix 契约）：sid 走内部头 `x-tmex-set-session`，
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

/** `GET /api/mesh/nodes` 的单行（**需会话**）。 */
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
  /** 该 node 是否是 hub 机（来自 hub 下发的 `node.list`，node 侧持久化）。 */
  isHub?: boolean;
}

export interface MeshNodesResponse {
  nodes: MeshNode[];
}

/** `x-tmex-connection`：把请求绑到本标签页的那条 Gateway WS。 */
export const X_TMEX_CONNECTION_HEADER = 'x-tmex-connection';

/** `GET /api/mesh/connection` 的 200 响应。 */
export interface MeshConnectionResponse {
  connectionId: string;
}

/**
 * `NO_CONNECTION`：该 sid 在目标 node 上没有 live 的 Gateway WS（primary 还没连上 / 刚断）。
 * `MULTIPLE_CONNECTIONS`：同 sid 有多条（多标签），必须带 `x-tmex-connection` 才能定位。
 */
export type MeshConnectionErrorCode = 'NO_CONNECTION' | 'MULTIPLE_CONNECTIONS';

export type MeshConnectionResult =
  | { ok: true; connectionId: string }
  | { ok: false; status: number; code: MeshConnectionErrorCode | string };

/** `GET /api/auth/nodes` 的单行（**公开**，不含公钥 / inventory）。登录页在登录前用它。 */
export interface PublicNode {
  id: string;
  name: string;
  online: boolean;
}

export interface PublicNodesResponse {
  nodes: PublicNode[];
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
  uid?: string;
}

/** `POST /api/auth/keylog` 请求体。 */
export interface KeyLogAppendRequest {
  /** base64url(borsh(KeyLogRecord)) */
  bytes: string;
  /** base64url(sig)：root=64B Ed25519；passkey=borsh(PasskeyAssertion) */
  sig: string;
}

/**
 * `POST /api/auth/keylog` 结果。
 *
 * `hub=sync` 模式下 entry 先把记录送 hub 并等 ack，再本地 append，响应带 `hubAck`：
 * 只有 `hubAck === true` 才代表 hub 已持久化该记录，admit / revoke 必须据此决定是否清 pending。
 */
export type KeyLogAppendResult =
  | { ok: true; seq?: number | string; hash?: string; hubAck?: boolean; hubError?: string }
  | { ok: false; code: 'KEY_LOG_FORK' | (string & {}) };

/** `GET /api/auth/passkeys`（需会话）。 */
export interface PasskeySummary {
  credential_id: string;
  name: string | null;
  rp_id: string;
  /** 注册时的精确 origin；跨 origin 选凭证时按它过滤。 */
  origin: string;
  device_type?: string;
  created_at?: number;
  log_seq?: number | string;
  /**
   * 服务端判定：`row.origin === 本次请求的可信 origin`（B2-8）。
   *
   * 服务端的判定优于前端拿 `location.origin` 自己比——反代场景下前端看到的 origin
   * 未必是断言时真正用的那个。旧 entry 不下发该字段，此时按 `origin` 字符串全等兜底。
   */
  usableHere?: boolean;
}

/** `GET /n/<hub>/api/hub/enrollments/:id`：redeem 后带证书。 */
export interface HubEnrollmentStatus {
  status: 'pending' | 'redeemed';
  enroll_pk: string;
  /** base64url(borsh(Certificate))；`status==='redeemed'` 时存在。 */
  certificate?: string;
  /** base64url，64 字节。 */
  cert_sig?: string;
  node_id?: string;
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
