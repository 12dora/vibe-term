import { describe, expect, spyOn, test } from 'bun:test';
import { maskAuthClientIp } from './auth-audit-log';
import { loginRequestContext } from './auth-key-log-routes';
import { LoginFailureLimiter } from './auth-login-limiter';
import {
  CHALLENGE_RATE_LIMIT,
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_WINDOW_MS,
  setMeshRequestContext,
} from './mesh-deps';

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

  test('does not emit lockout lines; TOTP limiter owns that event', () => {
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((msg: unknown) => {
      lines.push(String(msg));
    });
    try {
      const limiter = new LoginFailureLimiter(() => 1_000);
      for (let n = 0; n < LOGIN_RATE_LIMIT + 2; n += 1) limiter.recordFailure('uid:user');
      expect(lines.some((line) => line.includes('[auth] login locked'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
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

describe('maskAuthClientIp', () => {
  test('masks v4 /24, v6 /48, and collapses peer/local', () => {
    expect(maskAuthClientIp('10.0.1.55')).toBe('10.0.1.0');
    expect(maskAuthClientIp('203.0.113.44')).toBe('203.0.113.0');
    expect(maskAuthClientIp('2001:db8:abcd:0012:0000:0000:0000:00ff')).toBe('2001:db8:abcd::');
    expect(maskAuthClientIp('2001:db8::1')).toBe('2001:db8::');
    expect(maskAuthClientIp('::1')).toBe('::');
    expect(maskAuthClientIp('::ffff:192.168.1.42')).toBe('::ffff:192.168.1.0');
    expect(maskAuthClientIp('peer:entry')).toBe('peer');
    expect(maskAuthClientIp('local')).toBe('local');
    expect(maskAuthClientIp('')).toBe('-');
  });
});

describe('loginRequestContext', () => {
  test('peer logins ignore X-Forwarded-For and leave the IP bucket empty', () => {
    const req = new Request('http://localhost/api/auth/login', {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    setMeshRequestContext(req, {
      via: 'ab'.repeat(16),
      clientIp: 'peer:entry',
      trustProxy: true,
    });
    expect(loginRequestContext(req)).toEqual({ peer: true, ip: '' });
  });

  test('direct logins key the IP bucket on the resolved client address', () => {
    const req = new Request('http://localhost/api/auth/login');
    setMeshRequestContext(req, { via: 'self', clientIp: '198.51.100.8' });
    expect(loginRequestContext(req)).toEqual({ peer: false, ip: '198.51.100.8' });
  });
});
