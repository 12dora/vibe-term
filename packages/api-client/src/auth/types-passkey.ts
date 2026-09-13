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
