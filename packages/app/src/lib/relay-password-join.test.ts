import { describe, expect, test } from 'bun:test';
import { RelayPackError } from '../../../shared/src/relay';
import { RelayApiError, RelayTimeoutError } from '../commands/relay-shared';
import { RelayCaError } from './relay-ca';
import { wrapRelayPasswordJoinError } from './relay-password-join';
import { RelayPasswordJoinError } from './relay-password-join-flow';

describe('wrapRelayPasswordJoinError', () => {
  const cases: Array<{ name: string; error: unknown; code: string }> = [
    {
      name: 'wrong password / bad proof',
      error: new RelayApiError(401, 'RELAY_BAD_PROOF', 'bad proof'),
      code: 'relay_password_invalid',
    },
    {
      name: 'HTTP 401 without code',
      error: new RelayApiError(401, 'OTHER', 'unauthorized'),
      code: 'relay_password_invalid',
    },
    {
      name: 'unknown tenant',
      error: new RelayApiError(404, 'RELAY_TENANT_NOT_FOUND', 'missing'),
      code: 'relay_tenant_unknown',
    },
    {
      name: 'sealed pack API',
      error: new RelayApiError(409, 'RELAY_PACK_MISSING', 'missing pack'),
      code: 'relay_pack_invalid',
    },
    {
      name: 'RelayPackError open/AAD',
      error: new RelayPackError('aad mismatch'),
      code: 'relay_pack_invalid',
    },
    {
      name: 'head_hash_mismatch',
      error: new RelayPasswordJoinError('head_hash_mismatch', 'head moved'),
      code: 'relay_pack_invalid',
    },
    {
      name: 'timeout',
      error: new RelayTimeoutError('pack', 15_000),
      code: 'relay_unreachable',
    },
    {
      name: 'CA transport',
      error: new RelayCaError('ca_unavailable', 'fetch failed', true),
      code: 'relay_unreachable',
    },
    {
      name: 'ECONNREFUSED',
      error: new Error('connect ECONNREFUSED 127.0.0.1:19993'),
      code: 'relay_unreachable',
    },
    {
      name: 'local user exists passthrough',
      error: new RelayPasswordJoinError('local_user_exists', 'already has a mesh user'),
      code: 'local_user_exists',
    },
    {
      name: 'relay not authorized passthrough',
      error: new RelayPasswordJoinError('relay_not_authorized', 'not in list'),
      code: 'relay_not_authorized',
    },
    {
      name: 'CA fingerprint (not transport)',
      error: new RelayCaError('ca_fingerprint_mismatch', 'fingerprint mismatch'),
      code: 'join_failed',
    },
    {
      name: 'other API error',
      error: new RelayApiError(400, 'RELAY_QUOTA', 'quota'),
      code: 'join_failed',
    },
    {
      name: 'injected after unpack',
      error: new Error('injected after unpack'),
      code: 'join_failed',
    },
  ];

  for (const row of cases) {
    test(`${row.name} → ${row.code}`, () => {
      const wrapped = wrapRelayPasswordJoinError(row.error);
      expect(wrapped).toBeInstanceOf(RelayPasswordJoinError);
      expect(wrapped.code).toBe(row.code);
    });
  }
});
