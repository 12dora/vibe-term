/** 中继 uplink 连接错误的稳定分类（网关按原始 reason 归一化，前端据此查 i18n）。 */
export const RELAY_LINK_ERROR_CODES = [
  'connect-failed',
  'connect-timeout',
  'auth-timeout',
  'auth-rejected',
  'heartbeat-lost',
  'kicked',
  'revoked',
  'dns',
  'refused',
  'tls',
  'protocol',
  'unknown',
] as const;

export type RelayLinkErrorCode = (typeof RELAY_LINK_ERROR_CODES)[number];
