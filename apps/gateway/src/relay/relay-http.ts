/**
 * 中继错误码默认 UPPER_SNAKE。租户 rotate / 节点转发的接入口令一组
 *（`relay_password_*` / `relay_members_offline` / `relay_unreachable` / `relay_not_attached`）
 * 按契约用 lowercase_snake，与前端映射一致；新码保持该组的命名。
 */
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
  tokenNotCurrent: 'RELAY_TOKEN_NOT_CURRENT',
  tenantKicked: 'RELAY_TENANT_KICKED',
  membersOffline: 'relay_members_offline',
  enrollPasswordInvalid: 'relay_password_invalid',
  enrollPasswordTooShort: 'relay_password_too_short',
  enrollPasswordUnset: 'relay_password_unset',
  unreachable: 'relay_unreachable',
  notAttached: 'relay_not_attached',
  tenantNotFound: 'RELAY_TENANT_NOT_FOUND',
  quotaNodes: 'RELAY_QUOTA_NODES',
  quotaTenants: 'RELAY_QUOTA_TENANTS',
  enrollmentUnknown: 'RELAY_ENROLLMENT_UNKNOWN',
  enrollmentUsed: 'RELAY_ENROLLMENT_USED',
  enrollmentExpired: 'RELAY_ENROLLMENT_EXPIRED',
  enrollmentConflict: 'RELAY_ENROLLMENT_CONFLICT',
  enrollmentQuota: 'ENROLLMENT_QUOTA',
  enrollmentRateLimited: 'ENROLLMENT_RATE_LIMITED',
  badCertificate: 'RELAY_BAD_CERTIFICATE',
  badCertSig: 'RELAY_BAD_CERT_SIG',
  badPop: 'RELAY_BAD_POP',
  nodeRevoked: 'RELAY_NODE_REVOKED',
  badQuota: 'RELAY_BAD_QUOTA',
  badLimits: 'RELAY_BAD_LIMITS',
  upgradeFailed: 'RELAY_UPGRADE_FAILED',
  packMissing: 'RELAY_PACK_MISSING',
  packEpoch: 'RELAY_PACK_EPOCH_MISMATCH',
  packHeadAhead: 'RELAY_PACK_HEAD_AHEAD',
  packTooLarge: 'RELAY_PACK_TOO_LARGE',
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
  const retryAfterMs =
    extra && typeof extra.retryAfterMs === 'number' && Number.isFinite(extra.retryAfterMs)
      ? extra.retryAfterMs
      : undefined;
  const headers = new Headers({ 'content-type': 'application/json' });
  if (retryAfterMs !== undefined && retryAfterMs >= 0) {
    headers.set('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  }
  return new Response(JSON.stringify({ error: { code, message: code, ...extra } }), {
    status,
    headers,
  });
}

export function relayNoStore(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
