import type { LocalAuthStatus } from '@vibeterm/shared';

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
  /**
   * **当前 origin** 已注册 ≥1 把通行密钥：密码登录必须附带通行密钥二次验证
   * （`AuthLoginRequest.passkey`），否则服务端回 `PASSKEY_REQUIRED`。旧版本节点不返回该字段。
   *
   * 断言只能在注册它的 origin 上完成，所以这里按 origin 判定：别处注册的钥匙不会让
   * 这个地址要求一个永远做不完的仪式（见 `passkeysRegisteredElsewhere`）。
   */
  passkeySecondFactor?: boolean;
  /** 二次验证策略：'either' = 有效 TOTP 或本 origin 通行密钥断言其一即可；旧节点不下发。 */
  secondFactorPolicy?: 'either' | 'totp' | 'passkey' | 'none';
  /**
   * 名下有通行密钥，但没有一把注册在当前 origin：登录页据此提示「登录后为此地址添加」。
   * 旧版本节点不返回该字段。
   */
  passkeysRegisteredElsewhere?: boolean;
  /**
   * 入口判定浏览器来自受信本机来源时，即使账号已注册通行密钥也不要求二次验证。
   * 此时 `passkeySecondFactor` 为 false。旧版本节点不返回该字段。
   */
  passkeySecondFactorWaived?: boolean;
  totpEnabled?: boolean;
  /** mesh 模式必填；standalone 与「没有主用户」时为 `null`。 */
  rootEpoch?: number | null;
  /** base64url，32 字节：当前根公钥。join 串第二段用它。 */
  rootPublicKey?: string | null;
  /** hub 机所在 node 的 id（本机即 hub 时为自身 id）。 */
  hubNodeId?: string | null;
  /** hub 的对外可达地址；join 命令只能用它，绝不能退化成入口 origin。 */
  hubPublicUrl?: string | null;
  /** self-signed CA 的 SPKI sha256 hex；无 CA 时为 null。 */
  caFingerprint?: string | null;
  /**
   * standalone 本机登录开关的状态（加性字段）。旧后端不下发：缺失时只能按「未知」处理，
   * 绝不能当成「没有保护」——那会把已受保护的实例误报成裸奔。
   */
  localAuth?: LocalAuthStatus;
}

/** `POST /api/auth/local` 与 `POST /api/auth/local/bootstrap` 的 200 响应。 */
export interface LocalAuthMutationResponse {
  ok: true;
  localAuth: LocalAuthStatus;
}

/**
 * 本机登录接口的 `{code}`：`LOCAL_ONLY` 是 403（只允许从本机调用），
 * `CREDENTIALS_REQUIRED` / `CREDENTIALS_EXIST` / `LOCAL_AUTH_ENABLED` 是 409，
 * `not_standalone` 是 404（hub/node 上没有这个开关）。
 */
export type LocalAuthErrorCode =
  | 'not_standalone'
  | 'LOCAL_ONLY'
  | 'CREDENTIALS_REQUIRED'
  | 'LOCAL_AUTH_ENABLED'
  | 'CREDENTIALS_EXIST'
  | 'invalid_username'
  | 'weak_password'
  | 'MALFORMED'
  | (string & {});

/** 本机登录接口的非 2xx：`code` 必须原样保留，调用方据此选文案。 */
export class LocalAuthApiError extends Error {
  constructor(
    readonly code: LocalAuthErrorCode,
    readonly status: number
  ) {
    super(`local auth request failed: ${code}`);
    this.name = 'LocalAuthApiError';
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
