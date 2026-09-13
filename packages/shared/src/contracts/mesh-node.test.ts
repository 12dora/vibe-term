import { describe, expect, test } from 'bun:test';
import { DIRECT_FAILURE_CODES, type DirectFailureCode } from './mesh-node';

describe('DIRECT_FAILURE_CODES', () => {
  test('array is the DirectFailureCode source', () => {
    const codes: DirectFailureCode[] = [...DIRECT_FAILURE_CODES];
    expect(codes).toEqual([
      'timeout',
      'refused',
      'unreachable',
      'reset',
      'tls',
      'handshake',
      'revoked',
      'untrusted',
      'backoff',
      'no_endpoints',
      'ice_failed',
      'no_candidates',
      'dc_open_timeout',
      'dc_closed',
      'liveness_timeout',
      'signal_dropped',
      'signaling_state',
      'rtc_unavailable',
      'not_direct_capable',
      'breaker_cooling',
      'breaker_paused',
      'aborted',
      'no_srflx',
      'stun_unconfigured',
      'other',
    ]);
  });
});
