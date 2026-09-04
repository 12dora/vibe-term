import { describe, expect, test } from 'bun:test';
import { type RelayLinkErrorCode, classifyRelayLinkError } from './relay-link-error';

const CASES: Array<[string | null | undefined, RelayLinkErrorCode | null]> = [
  [null, null],
  [undefined, null],
  ['', null],
  ['   ', null],
  ['stopped', null],
  ['aborted', null],
  ['connect-failed', 'connect-failed'],
  ['connect-timeout', 'connect-timeout'],
  ['timeout', 'connect-timeout'],
  ['ETIMEDOUT', 'connect-timeout'],
  ['auth-timeout', 'auth-timeout'],
  ['auth_rejected', 'auth-rejected'],
  ['bad-token', 'auth-rejected'],
  ['token-epoch', 'auth-rejected'],
  ['unauthorized', 'auth-rejected'],
  ['bad-sig', 'auth-rejected'],
  ['member-epoch_mismatch', 'auth-rejected'],
  ['member-revoked', 'auth-rejected'],
  ['missed-pong', 'heartbeat-lost'],
  ['ping-failed', 'heartbeat-lost'],
  ['kicked:password_rotated', 'kicked'],
  ['kicked', 'kicked'],
  ['tenant-kicked', 'kicked'],
  ['revoked', 'kicked'],
  ['ECONNREFUSED', 'refused'],
  ['refused', 'refused'],
  ['connection refused', 'refused'],
  ['ENOTFOUND', 'dns'],
  ['dns', 'dns'],
  ['getaddrinfo ENOTFOUND', 'dns'],
  ['unable to verify the first certificate', 'tls'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
  ['self-signed certificate', 'tls'],
  ['protocol', 'protocol'],
  ['proto-unsupported', 'protocol'],
  ['client-too-old', 'protocol'],
  ['ws-closed 1006', 'protocol'],
  ['http_4401', 'unknown'],
  ['something-else', 'unknown'],
];

describe('classifyRelayLinkError', () => {
  test('table: raw reason → closed error code', () => {
    for (const [raw, code] of CASES) {
      expect(classifyRelayLinkError(raw)).toBe(code);
    }
  });
});
