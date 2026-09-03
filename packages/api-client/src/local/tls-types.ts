// 内置 HTTPS（`GET/PUT /api/tls`、`POST /api/tls/renew`、`GET /api/tls/ca.crt`）的线上类型。
//
// 私钥永远不出现在任何响应里；自签模式只回 CA 指纹与证书摘要，ACME 只回状态机字段。

export type TlsMode = 'none' | 'external' | 'selfsigned' | 'acme';

export type TlsChallenge = 'http-01' | 'dns-01';

export type TlsDnsProviderId = 'cloudflare' | 'dnspod';

export type TlsCloudflareDnsCredentials = { token: string };
export type TlsDnspodDnsCredentials = { id: string; token: string };
export type TlsDnsCredentials = TlsCloudflareDnsCredentials | TlsDnspodDnsCredentials;

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
  /** 当前 ACME dns-01 提供商；无凭证时 `provider` 仍可能为上次保存的值。 */
  dns: { provider: TlsDnsProviderId | null; hasCredentials: boolean };
}

/**
 * 对外「有效 HTTPS」判定，与内置监听器状态分开：
 * - builtin：tmex 内置 HTTPS 监听器在运行；
 * - reverse-proxy：TLS 由反向代理终止。`verified=true` 表示本次请求经受信任的代理头
 *   （trustProxy）确认为 https；`verified=false` 表示仅由配置的公开地址（hub 公开地址 / TMEX_BASE_URL）
 *   的 scheme 推断；
 * - none：没有任何 HTTPS 证据。
 * 旧版本节点不返回该字段。
 */
export interface TlsEffectiveHttps {
  source: 'builtin' | 'reverse-proxy' | 'none';
  verified: boolean;
  /** 推断所依据的公开地址；没有时为 null。 */
  publicUrl: string | null;
}

export interface TlsStatusResponse {
  mode: TlsMode;
  https?: TlsEffectiveHttps;
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
  /** dns-01 提供商；省略时沿用已存，或在只传 `cloudflareToken` 时视为 cloudflare。 */
  dnsProvider?: TlsDnsProviderId;
  /** 与 `dnsProvider` 配套的凭证；同一提供商已有凭证时可省略。 */
  dnsCredentials?: TlsDnsCredentials;
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
  | 'dns_provider_required'
  | 'dns_credentials_required'
  | 'invalid_port'
  | 'port_in_use'
  | 'tls_failed'
  | 'not_applicable'
  | 'no_ca';

export const DEFAULT_TLS_PORT = 9443;
export const DEFAULT_TLS_BIND_HOST = '0.0.0.0';
