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
  [
    "WebSocket connection to 'ws://127.0.0.1:19864/relay/uplink' failed: Failed to connect",
    'connect-failed',
  ],
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
  ['heartbeat-timeout', 'heartbeat-lost'],
  ['heartbeat_timeout', 'heartbeat-lost'],
  ['unknown-tenant', 'auth-rejected'],
  ['protocol_error', 'protocol'],
  ['protocol-error', 'protocol'],
  ['http_4401', 'unknown'],
  ['something-else', 'unknown'],
];

/** `relay-uplink-auth.ts` / `relay-uplink-server.ts` 实际 close/reject 的原因，每条都要有明确分类。 */
const SERVER_REASONS: Array<[string, RelayLinkErrorCode]> = [
  ['auth-timeout', 'auth-timeout'],
  ['revoked', 'kicked'],
  ['member-required', 'auth-rejected'],
  ['member-malformed', 'auth-rejected'],
  ['member-type_mismatch', 'auth-rejected'],
  ['member-bad_signature', 'auth-rejected'],
  ['member-node_mismatch', 'auth-rejected'],
  ['member-epoch_mismatch', 'auth-rejected'],
  ['member-seq_mismatch', 'auth-rejected'],
  ['member-passkey_unverifiable', 'auth-rejected'],
  ['bad-sig', 'auth-rejected'],
  ['unauthorized', 'auth-rejected'],
  ['proto-unsupported', 'protocol'],
  ['client-too-old', 'protocol'],
  ['tenant-kicked', 'kicked'],
  ['unknown-tenant', 'auth-rejected'],
  ['token-epoch', 'auth-rejected'],
  ['bad-token', 'auth-rejected'],
  ['relay-replaced', 'protocol'],
  ['relay-stop', 'protocol'],
  ['relay-kicked', 'kicked'],
  ['relay-password_rotated', 'kicked'],
  ['relay-revoked', 'kicked'],
  ['protocol_error', 'protocol'],
  ['unauthenticated', 'auth-rejected'],
  ['relay-tenant-gone', 'kicked'],
  ['heartbeat-timeout', 'heartbeat-lost'],
];

describe('classifyRelayLinkError', () => {
  test('table: raw reason → closed error code', () => {
    for (const [raw, code] of CASES) {
      expect(classifyRelayLinkError(raw)).toBe(code);
    }
  });

  test('table: relay server close/reject reasons map to a deliberate code', () => {
    for (const [raw, code] of SERVER_REASONS) {
      expect(classifyRelayLinkError(raw)).toBe(code);
    }
  });
});
