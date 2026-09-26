import { describe, expect, spyOn, test } from 'bun:test';
import { standardLoginPolicy } from '@vibeterm/shared/auth';
import { maskAuthClientIp } from './auth-audit-log';
import { loginRequestContext } from './auth-key-log-routes';
import {
  LOGIN_LADDER_WINDOW_MS,
  LoginFailureLimiter,
  LoginPolicyLimiter,
} from './auth-login-limiter';
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

describe('LoginPolicyLimiter', () => {
  const policy = standardLoginPolicy();
  const attempt = (ip: string, uid = 'user', method: 'root' | 'passkey' | null = 'root') => ({
    ip,
    uid,
    method,
    exempt: false as const,
  });

  test('locks a public IP for the standard base after 10 failures and reports retryAfterMs', () => {
    let now = 1_000_000;
    const limiter = new LoginPolicyLimiter(
      () => now,
      () => policy
    );
    for (let n = 0; n < 9; n += 1) limiter.recordFailure(attempt('203.0.113.1'));
    expect(limiter.check(attempt('203.0.113.1'))).toBeNull();
    limiter.recordFailure(attempt('203.0.113.1'));
    const hit = limiter.check(attempt('203.0.113.1'));
    expect(hit).toEqual({ code: 'RATE_LIMITED', retryAfterMs: policy.ipLockBaseMs });
    now += policy.ipLockBaseMs;
    expect(limiter.check(attempt('203.0.113.1'))).toBeNull();
  });

  test('success clears the failure count but the next lock in 24h doubles', () => {
    let now = 1_000_000;
    const limiter = new LoginPolicyLimiter(
      () => now,
      () => policy
    );
    for (let n = 0; n < 9; n += 1) limiter.recordFailure(attempt('203.0.113.2'));
    limiter.recordSuccess('203.0.113.2');
    for (let n = 0; n < 9; n += 1) limiter.recordFailure(attempt('203.0.113.2'));
    expect(limiter.check(attempt('203.0.113.2'))).toBeNull();
    limiter.recordFailure(attempt('203.0.113.2'));
    expect(limiter.check(attempt('203.0.113.2'))?.retryAfterMs).toBe(policy.ipLockBaseMs);
    now += policy.ipLockBaseMs;
    for (let n = 0; n < policy.ipFailThreshold; n += 1)
      limiter.recordFailure(attempt('203.0.113.2'));
    expect(limiter.check(attempt('203.0.113.2'))?.retryAfterMs).toBe(policy.ipLockBaseMs * 2);
    expect(policy.ipLockBaseMs * 2).toBeLessThan(LOGIN_LADDER_WINDOW_MS);
  });

  test('account pause blocks password login only after the hourly cap', () => {
    const limiter = new LoginPolicyLimiter(
      () => 5_000,
      () => policy
    );
    for (let n = 0; n < policy.accountFailPerHour; n += 1) {
      limiter.recordFailure(attempt(`203.0.113.${(n % 200) + 1}`, 'acct'));
    }
    expect(limiter.check(attempt('198.51.100.1', 'acct'))).toBeNull();
    limiter.recordFailure(attempt('198.51.100.2', 'acct'));
    expect(limiter.check(attempt('198.51.100.3', 'acct'))).toEqual({
      code: 'PASSWORD_LOGIN_PAUSED',
      retryAfterMs: policy.accountLockMs,
    });
    expect(limiter.check(attempt('198.51.100.3', 'acct', 'passkey'))).toBeNull();
  });

  test('exempt skips the IP ladder and the account pause, and does not feed the window', () => {
    const tight = { ...policy, accountFailPerHour: 2, ipFailThreshold: 1 };
    const limiter = new LoginPolicyLimiter(
      () => 5_000,
      () => tight
    );
    const exempt = { ...attempt('10.0.0.9', 'acct'), exempt: true };
    for (let n = 0; n < 8; n += 1) limiter.recordFailure(exempt);
    expect(limiter.check(exempt)).toBeNull();
    expect(limiter.check(attempt('203.0.113.1', 'acct'))).toBeNull();
    limiter.recordFailure(attempt('203.0.113.1', 'acct'));
    limiter.recordFailure(attempt('203.0.113.2', 'acct'));
    expect(limiter.check(attempt('203.0.113.3', 'acct'))).toBeNull();
    limiter.recordFailure(attempt('203.0.113.4', 'acct'));
    expect(limiter.check(attempt('203.0.113.5', 'acct'))).toEqual({
      code: 'PASSWORD_LOGIN_PAUSED',
      retryAfterMs: policy.accountLockMs,
    });
    expect(limiter.check(exempt)).toBeNull();
    expect(limiter.check({ ...exempt, method: 'passkey' })).toBeNull();
  });

  test('account pause clears the failure window so one later failure does not re-pause', () => {
    let now = 1_000_000;
    const tight = { ...policy, accountFailPerHour: 2, ipFailThreshold: 1_000 };
    const limiter = new LoginPolicyLimiter(
      () => now,
      () => tight
    );
    for (let n = 0; n < 3; n += 1) limiter.recordFailure(attempt(`203.0.113.${n + 1}`, 'acct'));
    expect(limiter.check(attempt('198.51.100.1', 'acct'))?.code).toBe('PASSWORD_LOGIN_PAUSED');
    now += policy.accountLockMs + 1;
    limiter.recordFailure(attempt('198.51.100.2', 'acct'));
    expect(limiter.check(attempt('198.51.100.3', 'acct'))).toBeNull();
    limiter.recordFailure(attempt('198.51.100.4', 'acct'));
    limiter.recordFailure(attempt('198.51.100.5', 'acct'));
    expect(limiter.check(attempt('198.51.100.6', 'acct'))).toEqual({
      code: 'PASSWORD_LOGIN_PAUSED',
      retryAfterMs: policy.accountLockMs,
    });
  });

  test('countAccount false does not pause the uid', () => {
    const tight = { ...policy, accountFailPerHour: 1, ipFailThreshold: 100 };
    const limiter = new LoginPolicyLimiter(
      () => 5_000,
      () => tight
    );
    const entry = { ...attempt('203.0.113.9', 'user'), countAccount: false as const };
    limiter.recordFailure(entry);
    limiter.recordFailure(entry);
    expect(limiter.check(attempt('198.51.100.1', 'user'))).toBeNull();
  });

  test('evicts an idle bucket before a live lock, in insertion order', () => {
    const idlePolicy = { ...policy, ipFailThreshold: 2 };
    const limiter = new LoginPolicyLimiter(
      () => 5_000,
      () => idlePolicy,
      {
        maxKeys: 2,
        pruneEvery: 0,
      }
    );
    limiter.recordFailure(attempt('idle-old', ''));
    limiter.recordFailure(attempt('locked', ''));
    limiter.recordFailure(attempt('locked', ''));
    limiter.recordFailure(attempt('idle-new', ''));
    limiter.recordFailure(attempt('idle-new', ''));
    expect(limiter.check(attempt('locked', ''))?.code).toBe('RATE_LIMITED');
    expect(limiter.check(attempt('idle-new', ''))?.code).toBe('RATE_LIMITED');
    expect(limiter.check(attempt('idle-old', ''))).toBeNull();
    expect(limiter.size).toBeLessThanOrEqual(2);
  });

  test('evicts the lock that expires soonest when every bucket is locked', () => {
    let now = 1_000_000;
    const tight = {
      ...policy,
      ipFailThreshold: 1,
      ipLockBaseMs: 10_000,
      ipLockMaxMs: 10_000,
    };
    const limiter = new LoginPolicyLimiter(
      () => now,
      () => tight,
      { maxKeys: 2, pruneEvery: 0 }
    );
    limiter.recordFailure(attempt('early', ''));
    now += 5_000;
    limiter.recordFailure(attempt('late', ''));
    limiter.recordFailure(attempt('fresh', ''));
    expect(limiter.size).toBeLessThanOrEqual(2);
    expect(limiter.check(attempt('early', ''))).toBeNull();
    expect(limiter.check(attempt('late', ''))?.code).toBe('RATE_LIMITED');
    expect(limiter.check(attempt('fresh', ''))?.code).toBe('RATE_LIMITED');
  });

  test('evicts the account pause that ends soonest', () => {
    let now = 1_000_000;
    const tight = {
      ...policy,
      accountFailPerHour: 0,
      ipFailThreshold: 1_000,
      accountLockMs: 10_000,
    };
    const limiter = new LoginPolicyLimiter(
      () => now,
      () => tight,
      { maxKeys: 2, pruneEvery: 0 }
    );
    limiter.recordFailure(attempt('203.0.113.1', 'early'));
    now += 4_000;
    limiter.recordFailure(attempt('203.0.113.1', 'late'));
    limiter.recordFailure(attempt('203.0.113.1', 'fresh'));
    expect(limiter.check(attempt('203.0.113.1', 'early'))).toBeNull();
    expect(limiter.check(attempt('203.0.113.1', 'late'))?.code).toBe('PASSWORD_LOGIN_PAUSED');
    expect(limiter.check(attempt('203.0.113.1', 'fresh'))?.code).toBe('PASSWORD_LOGIN_PAUSED');
  });

  test('stays within maxKeys when locked buckets keep arriving', () => {
    const limiter = new LoginPolicyLimiter(
      () => 1_000_000,
      () => policy,
      {
        maxKeys: 32,
        pruneEvery: 0,
      }
    );
    for (let k = 0; k < 400; k += 1) {
      for (let n = 0; n < policy.ipFailThreshold; n += 1) {
        limiter.recordFailure({
          ip: `proxied:x${k}`,
          uid: '',
          method: null,
          exempt: false,
          countAccount: false,
        });
      }
    }
    expect(limiter.size).toBeLessThanOrEqual(32);
  });

  test('evicts the oldest IP bucket past maxKeys', () => {
    const limiter = new LoginPolicyLimiter(
      () => 5_000,
      () => policy,
      { maxKeys: 2 }
    );
    limiter.recordFailure(attempt('203.0.113.1', ''));
    limiter.recordFailure(attempt('203.0.113.2', ''));
    limiter.recordFailure(attempt('203.0.113.3', ''));
    expect(limiter.check(attempt('203.0.113.1', ''))).toBeNull();
    limiter.recordFailure(attempt('203.0.113.3', ''));
    expect(limiter.size).toBeLessThanOrEqual(2);
  });
});
