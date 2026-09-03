import { describe, expect, test } from 'bun:test';
import {
  DIAL_BREAKER_FAILS,
  DIAL_BREAKER_HEALTHY_MS,
  DIAL_BREAKER_MAX_MS,
  DialBreaker,
} from './dial-breaker';

describe('DialBreaker', () => {
  test('trips after N consecutive failures', () => {
    const trips: Array<{
      peer: string;
      fails: number;
      level: number;
      cooldownMs: number;
      until: number;
    }> = [];
    const now = 1_000;
    const breaker = new DialBreaker({
      now: () => now,
      breakerMs: 30_000,
      onTrip: (event) => trips.push(event),
    });
    const peer = 'p';
    expect(breaker.noteFailure(peer, 'timeout', 'a1').opened).toBe(false);
    expect(breaker.noteFailure(peer, 'ice', 'a2').opened).toBe(false);
    const opened = breaker.noteFailure(peer, 'channel', 'a3');
    expect(opened).toEqual({
      counted: true,
      opened: true,
      open: true,
      until: 1_000 + 30_000,
    });
    expect(breaker.shouldTry(peer)).toMatchObject({
      allow: false,
      cooling: true,
      until: 1_000 + 30_000,
      failures: DIAL_BREAKER_FAILS,
      level: 1,
    });
    expect(trips).toEqual([{ fails: 3, level: 0, cooldownMs: 30_000, peer, until: 31_000 }]);
  });

  test('exponential cooldown doubles until the ceiling', () => {
    let now = 0;
    const breaker = new DialBreaker({ now: () => now, breakerMs: 30_000 });
    const peer = 'a';
    for (let i = 0; i < DIAL_BREAKER_FAILS; i += 1) {
      breaker.noteFailure(peer, 'timeout', `t${i}`);
    }
    expect(breaker.shouldTry(peer).until).toBe(30_000);

    now = 30_000;
    expect(breaker.noteFailure(peer, 'timeout', 'next').until).toBe(now + 60_000);

    for (let i = 0; i < 20; i += 1) {
      now = breaker.shouldTry(peer).until ?? now;
      breaker.noteFailure(peer, 'timeout', `cap${i}`);
    }
    const until = breaker.shouldTry(peer).until ?? 0;
    expect(until - now).toBeLessThanOrEqual(DIAL_BREAKER_MAX_MS);
    expect(breaker.shouldTry('other').allow).toBe(true);
  });

  test('healthy window of 60s resets debt; shorter does not', () => {
    const resets: number[] = [];
    let now = 10;
    const breaker = new DialBreaker({
      now: () => now,
      onReset: (event) => resets.push(event.healthyMs),
    });
    const peer = 'p';
    breaker.noteFailure(peer, 'timeout', '1');
    breaker.noteFailure(peer, 'timeout', '2');
    breaker.noteChannelEstablished(peer, '3');
    now = 10 + DIAL_BREAKER_HEALTHY_MS - 1;
    expect(breaker.noteHealthy(peer)).toBe(false);
    breaker.noteFailure(peer, 'liveness', '3');
    expect(breaker.shouldTry(peer).cooling).toBe(true);
    expect(resets).toEqual([]);

    now = breaker.shouldTry(peer).until ?? now;
    breaker.noteChannelEstablished(peer, '4');
    now += DIAL_BREAKER_HEALTHY_MS;
    expect(breaker.noteHealthy(peer)).toBe(true);
    expect(breaker.shouldTry(peer)).toMatchObject({
      allow: true,
      cooling: false,
      failures: 0,
      level: 0,
    });
    expect(resets).toEqual([DIAL_BREAKER_HEALTHY_MS]);
  });

  test('skipKinds filters empty and listed kinds without counting', () => {
    const breaker = new DialBreaker({
      now: () => 0,
      skipKinds: new Set(['signaling-not-ready', 'primary-wait', '']),
    });
    const peer = 'n';
    expect(breaker.noteFailure(peer, 'signaling-not-ready', '1').counted).toBe(false);
    expect(breaker.noteFailure(peer, 'primary-wait', '2').counted).toBe(false);
    expect(breaker.noteFailure(peer, '', '3').counted).toBe(false);
    expect(breaker.shouldTry(peer).failures).toBe(0);
    expect(breaker.snapshot(peer).lastFailureKind).toBeNull();
    expect(breaker.noteFailure(peer, 'timeout', '4').counted).toBe(true);
    expect(breaker.shouldTry(peer).failures).toBe(1);
  });
});
