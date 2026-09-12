import { describe, expect, test } from 'bun:test';
import {
  UNAUTH_GLOBAL_BURST,
  UNAUTH_IDLE_MS,
  UNAUTH_MAX_IPS,
  UNAUTH_PER_IP_BURST,
} from './turn-limits';
import { UnauthResponseLimiter } from './turn-unauth-limit';

describe('UnauthResponseLimiter', () => {
  test('per-IP burst then refill at 20/s', () => {
    let now = 1_000;
    const limiter = new UnauthResponseLimiter(() => now);
    for (let i = 0; i < UNAUTH_PER_IP_BURST; i++) expect(limiter.allow('203.0.113.1')).toBe(true);
    expect(limiter.allow('203.0.113.1')).toBe(false);
    now += 49;
    expect(limiter.allow('203.0.113.1')).toBe(false);
    now += 1;
    expect(limiter.allow('203.0.113.1')).toBe(true);
    now += 1_000;
    for (let i = 0; i < 20; i++) expect(limiter.allow('203.0.113.1')).toBe(true);
    expect(limiter.allow('203.0.113.1')).toBe(false);
  });

  test('per-IP buckets are independent', () => {
    const limiter = new UnauthResponseLimiter(() => 1);
    for (let i = 0; i < UNAUTH_PER_IP_BURST; i++) expect(limiter.allow('203.0.113.1')).toBe(true);
    expect(limiter.allow('203.0.113.1')).toBe(false);
    expect(limiter.allow('203.0.113.2')).toBe(true);
  });

  test('global cap of 2000/s applies across IPs', () => {
    let now = 0;
    const limiter = new UnauthResponseLimiter(() => now);
    let allowed = 0;
    for (let i = 0; i < UNAUTH_GLOBAL_BURST + 5; i++) {
      if (limiter.allow(`198.51.100.${i % 250}`)) allowed++;
    }
    expect(allowed).toBe(UNAUTH_GLOBAL_BURST);
    now += 1_000;
    expect(limiter.allow('203.0.113.9')).toBe(true);
  });

  test('evicts idle entries after 60s and LRU-evicts past 4096', () => {
    let now = 0;
    const limiter = new UnauthResponseLimiter(() => now);
    expect(limiter.allow('192.0.2.1')).toBe(true);
    now += UNAUTH_IDLE_MS - 1;
    expect(limiter.allow('192.0.2.2')).toBe(true);
    expect(limiter.size).toBe(2);
    now += 1;
    expect(limiter.allow('192.0.2.2')).toBe(true);
    expect(limiter.size).toBe(1);

    now += 1_000;
    for (let i = 0; i < UNAUTH_MAX_IPS; i++) {
      if (i > 0 && i % 2_000 === 0) now += 1_000;
      const a = (i >> 8) & 255;
      const b = i & 255;
      expect(limiter.allow(`203.0.${a}.${b}`)).toBe(true);
    }
    expect(limiter.size).toBe(UNAUTH_MAX_IPS);
    now += 1_000;
    expect(limiter.allow('198.51.100.1')).toBe(true);
    expect(limiter.size).toBe(UNAUTH_MAX_IPS);
  });
});
