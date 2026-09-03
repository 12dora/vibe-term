export const RelayErrorCode = {
  methodNotAllowed: 'RELAY_METHOD_NOT_ALLOWED',
  notFound: 'RELAY_NOT_FOUND',
  invalidBody: 'RELAY_INVALID_BODY',
  unauthorized: 'RELAY_UNAUTHORIZED',
  passwordInvalid: 'RELAY_PASSWORD_INVALID',
  passwordRequired: 'RELAY_PASSWORD_REQUIRED',
  rateLimited: 'RELAY_RATE_LIMITED',
  badProof: 'RELAY_BAD_PROOF',
  tokenInvalid: 'RELAY_TOKEN_INVALID',
  tenantKicked: 'RELAY_TENANT_KICKED',
  tenantNotFound: 'RELAY_TENANT_NOT_FOUND',
  quotaNodes: 'RELAY_QUOTA_NODES',
  enrollmentUnknown: 'RELAY_ENROLLMENT_UNKNOWN',
  enrollmentUsed: 'RELAY_ENROLLMENT_USED',
  enrollmentExpired: 'RELAY_ENROLLMENT_EXPIRED',
  badCertificate: 'RELAY_BAD_CERTIFICATE',
  badCertSig: 'RELAY_BAD_CERT_SIG',
  badPop: 'RELAY_BAD_POP',
  nodeRevoked: 'RELAY_NODE_REVOKED',
  badQuota: 'RELAY_BAD_QUOTA',
  upgradeFailed: 'RELAY_UPGRADE_FAILED',
} as const;

export type RelayErrorCodeValue = (typeof RelayErrorCode)[keyof typeof RelayErrorCode];

export function relayJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 契约错误体：`{ error: { code, message } }`（api-client 的 readCodedError 只认这个形状）。 */
export function relayError(
  code: RelayErrorCodeValue,
  status: number,
  extra?: Record<string, unknown>
): Response {
  return relayJson({ error: { code, message: code, ...extra } }, status);
}

export function relayNoStore(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
