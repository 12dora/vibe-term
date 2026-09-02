import { describe, expect, test } from 'bun:test';
import { LoginFailureLimiter } from './auth-login-limiter';
import { CHALLENGE_RATE_LIMIT, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS } from './mesh-deps';

describe('LoginFailureLimiter', () => {
  test('drops keys whose timestamp list becomes empty', () => {
    let now = 1_000;
    const limiter = new LoginFailureLimiter(() => now);
    limiter.recordFailure('ip:203.0.113.1');
    expect(limiter.size).toBe(1);

    now += LOGIN_RATE_WINDOW_MS;
    expect(limiter.isRateLimited('user', '203.0.113.1')).toBe(false);
    expect(limiter.size).toBe(0);
  });

  test('caps the number of keys by evicting the oldest', () => {
    const maxKeys = 8;
    const limiter = new LoginFailureLimiter(() => 1_000, { maxKeys });
    const ips = Array.from({ length: maxKeys + 2 }, (_, i) => `203.0.113.${i + 1}`);
    for (const ip of ips) {
      for (let n = 0; n < LOGIN_RATE_LIMIT; n += 1) {
        limiter.recordFailure(`ip:${ip}`);
      }
    }
    expect(limiter.size).toBe(maxKeys);
    expect(limiter.isRateLimited('user', ips[0] ?? '')).toBe(false);
    expect(limiter.isRateLimited('user', ips[1] ?? '')).toBe(false);
    expect(limiter.isRateLimited('user', ips[2] ?? '')).toBe(true);
    expect(limiter.isRateLimited('user', ips[ips.length - 1] ?? '')).toBe(true);
  });

  test('periodically sweeps expired keys so rotating IPs cannot grow the map', () => {
    let now = 1_000;
    const limiter = new LoginFailureLimiter(() => now, { pruneEvery: 4, maxKeys: 100 });
    limiter.recordFailure('ip:198.51.100.1');
    limiter.recordFailure('ip:198.51.100.2');
    limiter.recordFailure('ip:198.51.100.3');
    expect(limiter.size).toBe(3);

    now += LOGIN_RATE_WINDOW_MS;
    limiter.recordFailure('ip:203.0.113.9');
    expect(limiter.size).toBe(1);
    expect(limiter.isRateLimited('user', '198.51.100.1')).toBe(false);
    expect(limiter.isRateLimited('user', '203.0.113.9')).toBe(false);
  });

  test('record/count is a sliding window per key', () => {
    let now = 1_000;
    const limiter = new LoginFailureLimiter(() => now);
    for (let n = 0; n < CHALLENGE_RATE_LIMIT; n += 1) {
      limiter.record('ip:203.0.113.10');
    }
    expect(limiter.count('ip:203.0.113.10')).toBe(CHALLENGE_RATE_LIMIT);
    expect(limiter.count('ip:203.0.113.11')).toBe(0);

    limiter.record('ip:203.0.113.10');
    expect(limiter.count('ip:203.0.113.10')).toBe(CHALLENGE_RATE_LIMIT + 1);

    now += LOGIN_RATE_WINDOW_MS;
    expect(limiter.count('ip:203.0.113.10')).toBe(0);
    limiter.record('ip:203.0.113.10');
    expect(limiter.count('ip:203.0.113.10')).toBe(1);
  });
});
