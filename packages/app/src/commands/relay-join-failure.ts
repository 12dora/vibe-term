import { t } from '../i18n';
import { errorMessage } from '../lib/error-message';
import { RelayCaError } from '../lib/relay-ca';
import { RelayPasswordJoinError } from '../lib/relay-password-join-flow';
import { isRelayUnreachable } from '../lib/relay-unreachable';
import { JoinError } from './join-error';
import { RelayApiError } from './relay-shared';

const UNREACHABLE = 'relay.join.reason.unreachable';
const WRONG_PASSWORD = 'relay.join.reason.wrongPassword';
const TENANT_NOT_FOUND = 'relay.join.reason.tenantNotFound';
const NODE_REVOKED = 'relay.join.reason.nodeRevoked';
const CODE_INVALID = 'relay.join.reason.codeInvalid';

/** 密码加入里的 `RelayApiError` 会先被归一成 `RelayPasswordJoinError`，原始错误挂在 `cause` 上。 */
const API_REASONS: Record<string, string> = {
  RELAY_ENROLLMENT_USED: 'relay.join.reason.codeUsed',
  RELAY_ENROLLMENT_EXPIRED: 'relay.join.reason.codeExpired',
  RELAY_ENROLLMENT_UNKNOWN: CODE_INVALID,
  // 中继会清掉过期的 enrollment，lookup 对过期或敲错的加入码回 404 RELAY_NOT_FOUND
  RELAY_NOT_FOUND: CODE_INVALID,
  RELAY_TOKEN_INVALID: 'relay.join.reason.tokenRejected',
  RELAY_TOKEN_NOT_CURRENT: 'relay.join.reason.tokenRejected',
  RELAY_UNAUTHORIZED: 'relay.join.reason.tokenRejected',
  RELAY_TENANT_NOT_FOUND: TENANT_NOT_FOUND,
  RELAY_TENANT_KICKED: 'relay.join.reason.tenantKicked',
  RELAY_NODE_REVOKED: NODE_REVOKED,
  RELAY_QUOTA_NODES: 'relay.join.reason.quotaNodes',
  RELAY_RATE_LIMITED: 'relay.join.reason.rateLimited',
  ENROLLMENT_RATE_LIMITED: 'relay.join.reason.rateLimited',
};

const PASSWORD_JOIN_REASONS: Record<string, string> = {
  relay_password_invalid: WRONG_PASSWORD,
  relay_tenant_unknown: TENANT_NOT_FOUND,
  relay_unreachable: UNREACHABLE,
  relay_not_authorized: 'relay.join.reason.relayNotAuthorized',
  local_user_exists: 'relay.join.reason.localUserExists',
  relay_pack_invalid: 'relay.join.reason.packInvalid',
};

const JOIN_REASONS: Record<string, string> = {
  invalid_token: CODE_INVALID,
  node_revoked: NODE_REVOKED,
};

function reasonKeyOf(error: unknown): string | undefined {
  if (isRelayUnreachable(error)) return UNREACHABLE;
  if (error instanceof RelayApiError) return API_REASONS[error.code];
  if (error instanceof RelayPasswordJoinError) return PASSWORD_JOIN_REASONS[error.code];
  if (error instanceof JoinError) return JOIN_REASONS[error.code];
  if (error instanceof RelayCaError && error.code === 'ca_fingerprint_mismatch') {
    return 'relay.join.reason.caMismatch';
  }
  return undefined;
}

/** 沿 `cause` 链找第一个认得的错误，换成一句人话；认不出就给出最底层的原始信息。 */
function joinFailureReason(error: unknown): string {
  let current: unknown = error;
  let deepest: unknown = error;
  for (let depth = 0; current !== undefined && depth < 4; depth += 1) {
    const key = reasonKeyOf(current);
    if (key) return t(key);
    deepest = current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return errorMessage(deepest);
}

/** `relay join` 的终止信息：失败一律带「加入失败」前缀，原因只出现一次。 */
export function joinFailureMessage(error: unknown): string {
  return t('relay.join.failed', { reason: joinFailureReason(error) });
}
