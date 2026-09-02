import { describe, expect, test } from 'bun:test';
import {
  DIRECT_DIAL_BREAKER_FAILS,
  DIRECT_DIAL_BREAKER_HEALTHY_MS,
  DirectDialBreaker,
  classifyDirectDialFailure,
} from './direct-dial-breaker';

describe('DirectDialBreaker', () => {
  test('trips after 3 failures and forceProbe allows one cooling attempt', () => {
    const now = 0;
    const breaker = new DirectDialBreaker({ now: () => now });
    const peer = 'node-b';
    expect(breaker.noteFailure(peer, 'timeout', '1')).toBe(true);
    expect(breaker.noteFailure(peer, 'timeout', '1')).toBe(false);
    expect(breaker.noteFailure(peer, 'ice', '2')).toBe(true);
    expect(breaker.noteFailure(peer, 'channel', '3')).toBe(true);
    expect(breaker.shouldTry(peer)).toMatchObject({
      allow: false,
      cooling: true,
      failures: 3,
      level: 1,
    });
    breaker.forceProbe(peer);
    expect(breaker.shouldTry(peer).allow).toBe(true);
    breaker.beginAttempt(peer, 'probe');
    expect(breaker.shouldTry(peer).allow).toBe(false);
  });

  test('short-lived channel does not reset; healthy ≥ 60s does', () => {
    let now = 10;
    const breaker = new DirectDialBreaker({ now: () => now });
    const peer = 'n';
    breaker.noteFailure(peer, 'timeout', '1');
    breaker.noteFailure(peer, 'timeout', '2');
    breaker.noteChannelEstablished(peer, '3');
    now += DIRECT_DIAL_BREAKER_HEALTHY_MS - 1;
    expect(breaker.noteHealthy(peer)).toBe(false);
    breaker.noteFailure(peer, 'channel', '3');
    expect(breaker.shouldTry(peer).cooling).toBe(true);
    now = breaker.shouldTry(peer).until ?? now;
    breaker.noteChannelEstablished(peer, '4');
    now += DIRECT_DIAL_BREAKER_HEALTHY_MS;
    expect(breaker.noteHealthy(peer)).toBe(true);
    expect(breaker.shouldTry(peer)).toMatchObject({
      allow: true,
      cooling: false,
      failures: 0,
      level: 0,
    });
  });

  test('does not classify signaling-not-ready / primary-wait as failures', () => {
    expect(classifyDirectDialFailure('signaling not ready')).toBeNull();
    expect(classifyDirectDialFailure('connectionId: NO_CONNECTION')).toBeNull();
    expect(classifyDirectDialFailure('authorize failed (401)')).toBe('authorization');
    expect(classifyDirectDialFailure('node DTLS fingerprint mismatch')).toBe('fingerprint');
    expect(DIRECT_DIAL_BREAKER_FAILS).toBe(3);
  });
});
