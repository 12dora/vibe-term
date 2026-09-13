import { describe, expect, test } from 'bun:test';
import { RELAY_LINK_ERROR_CODES, type RelayLinkErrorCode } from './link-error';

describe('RELAY_LINK_ERROR_CODES', () => {
  test('closed set is the wire contract', () => {
    expect(RELAY_LINK_ERROR_CODES).toEqual([
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
    ]);
  });

  test('codes are unique', () => {
    expect(new Set(RELAY_LINK_ERROR_CODES).size).toBe(RELAY_LINK_ERROR_CODES.length);
  });

  test('every code is assignable to RelayLinkErrorCode', () => {
    const codes: readonly RelayLinkErrorCode[] = RELAY_LINK_ERROR_CODES;
    expect(codes).toBe(RELAY_LINK_ERROR_CODES);
  });
});
