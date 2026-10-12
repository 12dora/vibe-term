import { describe, expect, test } from 'bun:test';
import { RelayCaError } from '../lib/relay-ca';
import { JoinError } from './join-error';
import {
  RELAY_ENROLLMENT_LOOKUP_MISSING,
  isBareNotFound,
  shouldTryNextRelay,
} from './relay-join-failover';
import { RelayApiError, RelayTimeoutError, RelayTransportError } from './relay-shared';

describe('shouldTryNextRelay', () => {
  test('transport failures and a missing enrollment move on to the next relay', () => {
    expect(shouldTryNextRelay(new RelayTransportError('reset'))).toBe(true);
    expect(shouldTryNextRelay(new RelayTimeoutError('relay redeem', 1))).toBe(true);
    expect(shouldTryNextRelay(new RelayCaError('ca_unavailable', 'down', true))).toBe(true);
    expect(shouldTryNextRelay(new RelayApiError(404, 'RELAY_ENROLLMENT_UNKNOWN', 'x'))).toBe(true);
    expect(shouldTryNextRelay(new RelayApiError(404, 'RELAY_NOT_FOUND', 'x'))).toBe(true);
    expect(shouldTryNextRelay(new JoinError('join_failed', RELAY_ENROLLMENT_LOOKUP_MISSING))).toBe(
      true
    );
  });

  test('explicit refusals stop the failover', () => {
    expect(shouldTryNextRelay(new RelayApiError(404, 'RELAY_TENANT_NOT_FOUND', 'x'))).toBe(false);
    expect(shouldTryNextRelay(new RelayApiError(400, 'RELAY_ENROLLMENT_USED', 'x'))).toBe(false);
    expect(shouldTryNextRelay(new RelayCaError('ca_fingerprint_mismatch', 'x'))).toBe(false);
    expect(shouldTryNextRelay(new JoinError('join_failed', 'key log rejected: x'))).toBe(false);
  });
});

describe('isBareNotFound', () => {
  test('only a 404 without a contract error code counts', () => {
    expect(isBareNotFound(new RelayApiError(404, 'HTTP_404', 'x'))).toBe(true);
    expect(isBareNotFound(new RelayApiError(404, 'RELAY_NOT_FOUND', 'x'))).toBe(false);
    expect(isBareNotFound(new RelayApiError(500, 'HTTP_500', 'x'))).toBe(false);
    expect(isBareNotFound(new Error('x'))).toBe(false);
  });
});
