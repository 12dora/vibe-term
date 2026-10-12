import { describe, expect, test } from 'bun:test';
import { RelayPackError } from '../../../shared/src/relay';
import { RelayApiError, RelayTimeoutError, RelayTransportError } from '../commands/relay-shared';
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
      name: 'transport failure',
      error: new RelayTransportError('relay kdf failed: connect ECONNREFUSED 127.0.0.1:19993'),
      code: 'relay_unreachable',
    },
    {
      name: 'programming TypeError is not network trouble',
      error: new TypeError("undefined is not an object (evaluating 'body.kdf_params')"),
      code: 'join_failed',
    },
    {
      name: 'error text that merely looks like a network failure',
      error: new Error('connect ECONNREFUSED 127.0.0.1:19993'),
      code: 'join_failed',
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

describe('wrapRelayPasswordJoinError keeps the original error as cause', () => {
  test('RelayApiError survives every classification', () => {
    const rateLimited = new RelayApiError(429, 'RELAY_RATE_LIMITED', 'relay password join failed');
    const wrapped = wrapRelayPasswordJoinError(rateLimited);
    expect(wrapped.code).toBe('join_failed');
    expect(wrapped.cause).toBe(rateLimited);

    const wrong = new RelayApiError(401, 'RELAY_BAD_PROOF', 'bad proof');
    expect(wrapRelayPasswordJoinError(wrong).cause).toBe(wrong);
    const missing = new RelayApiError(404, 'RELAY_TENANT_NOT_FOUND', 'missing');
    expect(wrapRelayPasswordJoinError(missing).cause).toBe(missing);
  });

  test('transport, pack and generic failures keep their cause too', () => {
    const transport = new RelayTransportError('relay kdf failed: reset');
    expect(wrapRelayPasswordJoinError(transport).cause).toBe(transport);
    const pack = new RelayPackError('aad mismatch');
    expect(wrapRelayPasswordJoinError(pack).cause).toBe(pack);
    const plain = new Error('boom');
    expect(wrapRelayPasswordJoinError(plain).cause).toBe(plain);
  });

  test('an already wrapped error is returned unchanged', () => {
    const wrapped = new RelayPasswordJoinError('local_user_exists', 'already has a user');
    expect(wrapRelayPasswordJoinError(wrapped)).toBe(wrapped);
  });
});
