import { describe, expect, test } from 'bun:test';
import {
  SHARE_LOGIN_MAX_FAILURES,
  SHARE_LOGIN_WINDOW_MS,
  ShareLoginLimiter,
} from './share-rate-limit';

describe('ShareLoginLimiter', () => {
  test('窗口内累计 10 次失败后锁定，retryAfter 随时间递减', () => {
    let now = 1_000;
    const limiter = new ShareLoginLimiter(() => now);
    for (let i = 0; i < SHARE_LOGIN_MAX_FAILURES - 1; i++) {
      limiter.recordFailure('s1', 'ip1');
      expect(limiter.lockedFor('s1', 'ip1')).toBe(0);
    }
    limiter.recordFailure('s1', 'ip1');
    expect(limiter.lockedFor('s1', 'ip1')).toBe(SHARE_LOGIN_WINDOW_MS);
    now += 60_000;
    expect(limiter.lockedFor('s1', 'ip1')).toBe(SHARE_LOGIN_WINDOW_MS - 60_000);
    now += SHARE_LOGIN_WINDOW_MS;
    expect(limiter.lockedFor('s1', 'ip1')).toBe(0);
    expect(limiter.size).toBe(0);
  });

  test('按分享 + IP 分别计数', () => {
    let now = 0;
    const limiter = new ShareLoginLimiter(() => now);
    for (let i = 0; i < SHARE_LOGIN_MAX_FAILURES; i++) {
      limiter.recordFailure('s1', 'ip1');
      now += 1;
    }
    expect(limiter.lockedFor('s1', 'ip1')).toBeGreaterThan(0);
    expect(limiter.lockedFor('s1', 'ip2')).toBe(0);
    expect(limiter.lockedFor('s2', 'ip1')).toBe(0);
  });

  test('reset / clear 清空计数', () => {
    const limiter = new ShareLoginLimiter(() => 0);
    for (let i = 0; i < SHARE_LOGIN_MAX_FAILURES; i++) limiter.recordFailure('s1', 'ip1');
    limiter.reset('s1', 'ip1');
    expect(limiter.lockedFor('s1', 'ip1')).toBe(0);
    limiter.recordFailure('s1', 'ip1');
    limiter.clear();
    expect(limiter.size).toBe(0);
  });
});
