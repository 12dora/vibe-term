import { describe, expect, test } from 'bun:test';
import { RelayEnrollLimiter } from './relay-enroll-limiter';
import { RELAY_ENROLL_FAILURE_LIMIT } from './types';

describe('RelayEnrollLimiter', () => {
  test('ip and tenant buckets are independent; a request must pass both', () => {
    const limiter = new RelayEnrollLimiter(() => 1_000);
    for (let n = 0; n < RELAY_ENROLL_FAILURE_LIMIT; n += 1) {
      expect(limiter.isLimited('203.0.113.1', 'aa'.repeat(16))).toBe(false);
      limiter.recordFailure('203.0.113.1', 'aa'.repeat(16));
    }
    expect(limiter.isLimited('203.0.113.1', 'aa'.repeat(16))).toBe(true);
    expect(limiter.isLimited('203.0.113.1', 'bb'.repeat(16))).toBe(true);
    expect(limiter.isLimited('203.0.113.2', 'aa'.repeat(16))).toBe(true);
    expect(limiter.isLimited('203.0.113.2', 'bb'.repeat(16))).toBe(false);
  });

  test('eviction never removes a bucket still inside its window', () => {
    const limiter = new RelayEnrollLimiter(() => 1_000, RELAY_ENROLL_FAILURE_LIMIT, 60_000, 4);
    for (let i = 0; i < 6; i += 1) {
      limiter.recordFailure(`203.0.113.${i + 1}`);
    }
    expect(limiter.size).toBeGreaterThan(4);
    expect(limiter.count('203.0.113.1')).toBe(1);
    expect(limiter.isLimited('203.0.113.1')).toBe(false);
  });
});
