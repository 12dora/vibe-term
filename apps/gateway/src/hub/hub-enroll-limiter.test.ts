import { describe, expect, test } from 'bun:test';
import {
  HUB_ENROLL_FAIL_LIMIT,
  HUB_ENROLL_FAIL_WINDOW_MS,
  HUB_ENROLL_SUCCESS_LIMIT,
  HUB_ENROLL_SUCCESS_WINDOW_MS,
  HubEnrollLimiter,
} from './hub-enroll-limiter';

describe('HubEnrollLimiter', () => {
  test('proof failures slide by ip+uid', () => {
    let now = 1_000;
    const limiter = new HubEnrollLimiter(() => now);
    for (let n = 0; n < HUB_ENROLL_FAIL_LIMIT; n += 1) {
      expect(limiter.isLimited('203.0.113.1', 'user-1')).toBe(false);
      limiter.recordFailure('203.0.113.1', 'user-1');
    }
    expect(limiter.isLimited('203.0.113.1', 'user-1')).toBe(true);
    expect(limiter.isLimited('203.0.113.2', 'user-1')).toBe(false);
    expect(limiter.isLimited('203.0.113.1', 'user-2')).toBe(false);

    now += HUB_ENROLL_FAIL_WINDOW_MS;
    expect(limiter.isLimited('203.0.113.1', 'user-1')).toBe(false);
    expect(limiter.failureCount('203.0.113.1', 'user-1')).toBe(0);
  });

  test('successful creations cap per uid per hour', () => {
    let now = 1_000;
    const limiter = new HubEnrollLimiter(() => now);
    for (let n = 0; n < HUB_ENROLL_SUCCESS_LIMIT; n += 1) {
      expect(limiter.isLimited('203.0.113.1', 'user-1')).toBe(false);
      limiter.recordSuccess('user-1');
    }
    expect(limiter.isLimited('203.0.113.1', 'user-1')).toBe(true);
    expect(limiter.isLimited('203.0.113.9', 'user-1')).toBe(true);
    expect(limiter.isLimited('203.0.113.1', 'user-2')).toBe(false);

    now += HUB_ENROLL_SUCCESS_WINDOW_MS;
    expect(limiter.isLimited('203.0.113.1', 'user-1')).toBe(false);
    expect(limiter.successCount('user-1')).toBe(0);
  });

  test('caps the number of keys by evicting the oldest', () => {
    const limiter = new HubEnrollLimiter(() => 1_000, { maxKeys: 4 });
    for (let i = 0; i < 6; i += 1) {
      limiter.recordFailure(`203.0.113.${i + 1}`, 'user-1');
    }
    expect(limiter.size).toBe(4);
  });
});
