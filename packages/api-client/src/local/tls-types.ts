// 内置 HTTPS（`GET/PUT /api/tls`、`POST /api/tls/renew`、`GET /api/tls/ca.crt`）的线上类型。
//
// 私钥永远不出现在任何响应里；自签模式只回 CA 指纹与证书摘要，ACME 只回状态机字段。

export type TlsMode = 'none' | 'external' | 'selfsigned' | 'acme';

export type TlsChallenge = 'http-01' | 'dns-01';

/** ACME 签发状态机：`pending` 期间前端需要轮询。 */
export type TlsAcmeState = 'idle' | 'pending' | 'ok' | 'error';

/** 当前生效证书的摘要（毫秒时间戳）。 */
export interface TlsCertificateInfo {
  subject: string;
  sans: string[];
  notBefore: number;
  notAfter: number;
  issuer: string;
}

/** 独立 https 监听的运行态；`error` 为最近一次绑定/启动失败的原因。 */
export interface TlsListenerStatus {
  running: boolean;
  port: number | null;
  error: string | null;
}

export interface TlsAcmeStatus {
  email: string;
  domain: string;
  challenge: TlsChallenge;
  staging: boolean;
  status: TlsAcmeState;
  lastError: string | null;
  lastAttemptAt: number | null;
  nextRenewAt: number | null;
  /** 已存过 Cloudflare token：dns-01 再次保存时可以留空表示沿用。 */
  hasCloudflareToken: boolean;
}

export interface TlsStatusResponse {
  mode: TlsMode;
  trustProxy: boolean;
  tlsPort: number;
  bindHost: string;
  sans: string[];
  /** 自签 CA 的 SPKI sha256（hex）；其它模式为 null。 */
  caFingerprint: string | null;
  certificate: TlsCertificateInfo | null;
  listener: TlsListenerStatus;
  acme: TlsAcmeStatus | null;
  /** `trustProxy` 改动后为 true，直到网关重启。 */
  restartRequired: boolean;
}

export interface TlsUpdateNoneRequest {
  mode: 'none';
}

export interface TlsUpdateExternalRequest {
  mode: 'external';
  trustProxy: boolean;
}

export interface TlsUpdateSelfSignedRequest {
  mode: 'selfsigned';
  sans: string[];
  tlsPort: number;
  bindHost: string;
}

export interface TlsUpdateAcmeRequest {
  mode: 'acme';
  domain: string;
  email: string;
  challenge: TlsChallenge;
  /** 留空表示沿用已存的 token（`hasCloudflareToken` 为 true 时）。 */
  cloudflareToken?: string;
  staging: boolean;
  tlsPort: number;
  bindHost: string;
}

export type TlsUpdateRequest =
  | TlsUpdateNoneRequest
  | TlsUpdateExternalRequest
  | TlsUpdateSelfSignedRequest
  | TlsUpdateAcmeRequest;

/** 契约列举的错误码；未列举的码由调用方退化成「未知错误 + message」。 */
export type TlsErrorCode =
  | 'invalid_sans'
  | 'invalid_domain'
  | 'invalid_email'
  | 'cloudflare_token_required'
  | 'invalid_port'
  | 'port_in_use'
  | 'tls_failed'
  | 'not_applicable'
  | 'no_ca';

export const DEFAULT_TLS_PORT = 9443;
export const DEFAULT_TLS_BIND_HOST = '0.0.0.0';

/** 自签叶证书 398 天、ACME 90 天，都在到期前 30 天续期。 */
export const TLS_RENEW_WINDOW_DAYS = 30;
