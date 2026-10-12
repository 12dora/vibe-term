import { afterEach, describe, expect, test } from 'bun:test';
import { setLang, t } from '../i18n';
import { RelayCaError } from '../lib/relay-ca';
import { RelayPasswordJoinError } from '../lib/relay-password-join-flow';
import { JoinError } from './join-error';
import { joinFailureMessage } from './relay-join-failure';
import { RelayApiError, RelayTimeoutError, RelayTransportError } from './relay-shared';

afterEach(() => setLang('en'));

function reason(key: string): string {
  return t('relay.join.failed', { reason: t(key) });
}

describe('joinFailureMessage', () => {
  test.each([
    [new RelayApiError(404, 'RELAY_NOT_FOUND', 'x'), 'relay.join.reason.codeInvalid'],
    [new RelayApiError(400, 'RELAY_ENROLLMENT_UNKNOWN', 'x'), 'relay.join.reason.codeInvalid'],
    [new RelayApiError(400, 'RELAY_ENROLLMENT_USED', 'x'), 'relay.join.reason.codeUsed'],
    [new RelayApiError(400, 'RELAY_ENROLLMENT_EXPIRED', 'x'), 'relay.join.reason.codeExpired'],
    [new RelayApiError(404, 'RELAY_TENANT_NOT_FOUND', 'x'), 'relay.join.reason.tenantNotFound'],
    [new RelayApiError(401, 'RELAY_TOKEN_INVALID', 'x'), 'relay.join.reason.tokenRejected'],
    [new RelayApiError(429, 'RELAY_RATE_LIMITED', 'x'), 'relay.join.reason.rateLimited'],
    [new RelayApiError(409, 'RELAY_NODE_REVOKED', 'x'), 'relay.join.reason.nodeRevoked'],
    [new JoinError('invalid_token', 'x'), 'relay.join.reason.codeInvalid'],
    [new JoinError('node_revoked', 'x'), 'relay.join.reason.nodeRevoked'],
    [new RelayTransportError('x'), 'relay.join.reason.unreachable'],
    [new RelayTimeoutError('x', 1), 'relay.join.reason.unreachable'],
    [new RelayCaError('ca_unavailable', 'x', true), 'relay.join.reason.unreachable'],
    [new RelayCaError('ca_fingerprint_mismatch', 'x'), 'relay.join.reason.caMismatch'],
  ])('%#: maps to a human reason', (error, key) => {
    expect(joinFailureMessage(error)).toBe(reason(key));
  });

  test.each([
    ['relay_password_invalid', 'relay.join.reason.wrongPassword'],
    ['relay_tenant_unknown', 'relay.join.reason.tenantNotFound'],
    ['relay_unreachable', 'relay.join.reason.unreachable'],
    ['relay_not_authorized', 'relay.join.reason.relayNotAuthorized'],
    ['local_user_exists', 'relay.join.reason.localUserExists'],
    ['relay_pack_invalid', 'relay.join.reason.packInvalid'],
  ])('password join code %s maps to a human reason', (code, key) => {
    expect(joinFailureMessage(new RelayPasswordJoinError(code, 'raw'))).toBe(reason(key));
  });

  test('a password join error without its own reason falls through to the original API error', () => {
    const cause = new RelayApiError(429, 'RELAY_RATE_LIMITED', 'raw');
    const error = new RelayPasswordJoinError('join_failed', 'raw', { cause });
    expect(joinFailureMessage(error)).toBe(reason('relay.join.reason.rateLimited'));
    const mismatch = new RelayPasswordJoinError('join_failed', 'raw', {
      cause: new RelayCaError('ca_fingerprint_mismatch', 'raw'),
    });
    expect(joinFailureMessage(mismatch)).toBe(reason('relay.join.reason.caMismatch'));
  });

  test('a programming TypeError is shown as is, not as network trouble', () => {
    const error = new TypeError("undefined is not an object (evaluating 'x.y')");
    expect(joinFailureMessage(error)).toBe(t('relay.join.failed', { reason: error.message }));
  });

  test('an unmapped error prints the deepest cause message once', () => {
    const inner = new RelayApiError(400, 'RELAY_BAD_POP', 'relay redeem failed: HTTP 400');
    const outer = new Error('wrapper text', { cause: inner });
    expect(joinFailureMessage(outer)).toBe(t('relay.join.failed', { reason: inner.message }));
    expect(joinFailureMessage(inner).match(/Join failed/g)).toHaveLength(1);
  });

  test('follows the CLI language', () => {
    setLang('zh-CN');
    expect(joinFailureMessage(new RelayApiError(404, 'RELAY_NOT_FOUND', 'x'))).toBe(
      '加入失败：加入码无效或已过期，请重新生成加入码'
    );
  });
});
