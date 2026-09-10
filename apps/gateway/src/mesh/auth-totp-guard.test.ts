import { describe, expect, test } from 'bun:test';
import { TotpFailureLimiter, TotpLoginGuard, TotpReplayCache } from './auth-totp-guard';
import {
  TOTP_FAIL_LIMIT,
  TOTP_FAIL_WINDOW_MS,
  TOTP_LOCK_MAX_SHIFT,
  TOTP_REPLAY_TTL_MS,
} from './mesh-deps';

describe('TotpFailureLimiter', () => {
  test('locks after the failure budget and uses exponential lockouts', () => {
    let now = 1_000;
    const limiter = new TotpFailureLimiter(() => now);
    const uid = 'user-1';
    for (let n = 0; n < TOTP_FAIL_LIMIT; n += 1) {
      expect(limiter.isLimited(uid)).toBe(false);
      limiter.recordFailure(uid);
    }
    expect(limiter.isLimited(uid)).toBe(true);
    expect(limiter.lockedUntil(uid)).toBe(now + TOTP_FAIL_WINDOW_MS);

    now += TOTP_FAIL_WINDOW_MS;
    expect(limiter.isLimited(uid)).toBe(false);
    for (let n = 0; n < TOTP_FAIL_LIMIT; n += 1) limiter.recordFailure(uid);
    expect(limiter.lockedUntil(uid)).toBe(now + TOTP_FAIL_WINDOW_MS * 2);

    now += TOTP_FAIL_WINDOW_MS * 2;
    for (let n = 0; n < TOTP_FAIL_LIMIT; n += 1) limiter.recordFailure(uid);
    expect(limiter.lockedUntil(uid) - now).toBe(TOTP_FAIL_WINDOW_MS * 4);
  });

  test('caps the exponential shift', () => {
    let now = 1_000;
    const limiter = new TotpFailureLimiter(() => now);
    for (let window = 0; window < TOTP_LOCK_MAX_SHIFT + 3; window += 1) {
      now = limiter.lockedUntil('u') || now;
      for (let n = 0; n < TOTP_FAIL_LIMIT; n += 1) limiter.recordFailure('u');
    }
    const lockedFor = limiter.lockedUntil('u') - now;
    expect(lockedFor).toBe(TOTP_FAIL_WINDOW_MS * 2 ** TOTP_LOCK_MAX_SHIFT);
  });

  test('success clears lockout history', () => {
    const now = 5_000;
    const limiter = new TotpFailureLimiter(() => now);
    for (let n = 0; n < TOTP_FAIL_LIMIT; n += 1) limiter.recordFailure('u');
    expect(limiter.isLimited('u')).toBe(true);
    limiter.clear('u');
    expect(limiter.isLimited('u')).toBe(false);
    for (let n = 0; n < TOTP_FAIL_LIMIT; n += 1) limiter.recordFailure('u');
    expect(limiter.lockedUntil('u')).toBe(now + TOTP_FAIL_WINDOW_MS);
  });
});

describe('TotpReplayCache', () => {
  test('same sess_pk may retry; a different sess_pk is a replay', () => {
    const now = () => 10_000;
    const cache = new TotpReplayCache(now);
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    expect(cache.inspect('u', '123456', a)).toBe('fresh');
    cache.consume('u', '123456', a);
    expect(cache.inspect('u', '123456', a)).toBe('reuse');
    expect(cache.inspect('u', '123456', b)).toBe('conflict');
    expect(cache.inspect('u', '654321', b)).toBe('fresh');
  });

  test('expires after the TOTP acceptance window', () => {
    let now = 10_000;
    const cache = new TotpReplayCache(() => now);
    const sess = new Uint8Array(32).fill(3);
    cache.consume('u', '111111', sess);
    now += TOTP_REPLAY_TTL_MS;
    expect(cache.inspect('u', '111111', sess)).toBe('fresh');
    expect(cache.inspect('u', '111111', new Uint8Array(32).fill(4))).toBe('fresh');
  });
});

describe('TotpLoginGuard', () => {
  test('facade records failures and consumed codes', () => {
    const guard = new TotpLoginGuard(() => 1_000);
    const sess = new Uint8Array(32).fill(9);
    expect(guard.isLimited('u')).toBe(false);
    guard.consume('u', '000000', sess);
    expect(guard.replayStatus('u', '000000', sess)).toBe('reuse');
    for (let n = 0; n < TOTP_FAIL_LIMIT; n += 1) guard.recordFailure('u');
    expect(guard.isLimited('u')).toBe(true);
    guard.clearFailures('u');
    expect(guard.isLimited('u')).toBe(false);
  });
});
