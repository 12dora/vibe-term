import { describe, expect, test } from 'bun:test';
import { RelayApiError, RelayTimeoutError, RelayTransportError } from '../commands/relay-shared';
import { RelayCaError } from './relay-ca';
import { isRelayUnreachable } from './relay-unreachable';

describe('isRelayUnreachable', () => {
  test('recognises transport failures only', () => {
    expect(isRelayUnreachable(new RelayTransportError('relay redeem failed: reset'))).toBe(true);
    expect(isRelayUnreachable(new RelayTimeoutError('relay redeem', 15_000))).toBe(true);
    expect(isRelayUnreachable(new RelayCaError('ca_unavailable', 'down', true))).toBe(true);
  });

  test('programming errors and relay refusals are not network trouble', () => {
    expect(isRelayUnreachable(new TypeError("undefined is not an object (evaluating 'x.y')"))).toBe(
      false
    );
    expect(isRelayUnreachable(new Error('connect ECONNREFUSED 127.0.0.1:1'))).toBe(false);
    expect(isRelayUnreachable(new RelayApiError(502, 'HTTP_502', 'bad gateway'))).toBe(false);
    expect(isRelayUnreachable(new RelayCaError('ca_fingerprint_mismatch', 'mismatch'))).toBe(false);
  });
});
