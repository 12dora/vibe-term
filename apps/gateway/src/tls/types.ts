export type TlsMode = 'none' | 'external' | 'selfsigned' | 'acme';
export type AcmeChallengeType = 'http-01' | 'dns-01';
export type AcmeStatus = 'idle' | 'pending' | 'ok' | 'error';

export const TLS_CONFIG_ROW_ID = 1;
export const TLS_CONFIG_SCOPE = 'tls_config';
export const TLS_CONFIG_ENTITY_ID = '1';

export const DEFAULT_TLS_PORT = 9443;
export const DEFAULT_TLS_BIND_HOST = '0.0.0.0';

export type TlsConfigPublic = {
  id: typeof TLS_CONFIG_ROW_ID;
  mode: TlsMode;
  tlsPort: number;
  bindHost: string;
  sans: string[];
  caCertPem: string | null;
  certPem: string | null;
  certNotBefore: number | null;
  certNotAfter: number | null;
  acmeEmail: string | null;
  acmeDomain: string | null;
  acmeChallenge: AcmeChallengeType | null;
  acmeStaging: boolean;
  acmeAccountUrl: string | null;
  acmeStatus: AcmeStatus;
  acmeLastError: string | null;
  acmeLastAttemptAt: number | null;
  acmeNextRenewAt: number | null;
  hasCloudflareToken: boolean;
  hasCaKey: boolean;
  hasLeafKey: boolean;
  hasAccountKey: boolean;
  updatedAt: number;
};

export type TlsPrivateMaterial = {
  caKeyPem: string | null;
  keyPem: string | null;
  acmeCfToken: string | null;
  acmeAccountKey: string | null;
};

export type TlsConfigPatch = {
  mode?: TlsMode;
  tlsPort?: number;
  bindHost?: string;
  sans?: string[];
  caCertPem?: string | null;
  caKeyPem?: string | null;
  certPem?: string | null;
  keyPem?: string | null;
  certNotBefore?: number | null;
  certNotAfter?: number | null;
  acmeEmail?: string | null;
  acmeDomain?: string | null;
  acmeChallenge?: AcmeChallengeType | null;
  acmeStaging?: boolean;
  acmeCfToken?: string | null;
  acmeAccountKey?: string | null;
  acmeAccountUrl?: string | null;
  acmeStatus?: AcmeStatus;
  acmeLastError?: string | null;
  acmeLastAttemptAt?: number | null;
  acmeNextRenewAt?: number | null;
  updatedAt?: number;
};
