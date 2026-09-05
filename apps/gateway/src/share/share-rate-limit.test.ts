import { describe, expect, test } from 'bun:test';
import {
  SHARE_LOGIN_LOCK_MS,
  SHARE_LOGIN_MAX_CONCURRENT,
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

  test('第 10 次失败起锁满 15 分钟，与失败窗口独立', () => {
    let now = 0;
    const limiter = new ShareLoginLimiter(() => now);
    limiter.recordFailure('s1', 'ip1');
    now += SHARE_LOGIN_WINDOW_MS - 1_000;
    for (let i = 0; i < SHARE_LOGIN_MAX_FAILURES - 1; i++) limiter.recordFailure('s1', 'ip1');
    expect(limiter.lockedFor('s1', 'ip1')).toBe(SHARE_LOGIN_LOCK_MS);
    now += SHARE_LOGIN_LOCK_MS - 1;
    expect(limiter.lockedFor('s1', 'ip1')).toBe(1);
    now += 1;
    expect(limiter.lockedFor('s1', 'ip1')).toBe(0);
  });

  test('begin 预占额度：在途尝试计入上限，并发数封顶', () => {
    const limiter = new ShareLoginLimiter(() => 0);
    for (let i = 0; i < SHARE_LOGIN_MAX_CONCURRENT; i++) {
      expect(limiter.begin('s1', 'ip1')).toEqual({ ok: true });
    }
    const busy = limiter.begin('s1', 'ip1');
    expect(busy.ok).toBe(false);
    for (let i = 0; i < SHARE_LOGIN_MAX_CONCURRENT; i++) limiter.settle('s1', 'ip1', false);

    for (let i = SHARE_LOGIN_MAX_CONCURRENT; i < SHARE_LOGIN_MAX_FAILURES; i++) {
      expect(limiter.begin('s1', 'ip1')).toEqual({ ok: true });
      limiter.settle('s1', 'ip1', false);
    }
    expect(limiter.begin('s1', 'ip1').ok).toBe(false);
  });

  test('settle 成功即清空该分享 + IP 的失败记录', () => {
    const limiter = new ShareLoginLimiter(() => 0);
    for (let i = 0; i < SHARE_LOGIN_MAX_FAILURES - 1; i++) limiter.recordFailure('s1', 'ip1');
    expect(limiter.begin('s1', 'ip1')).toEqual({ ok: true });
    limiter.settle('s1', 'ip1', true);
    expect(limiter.size).toBe(0);
    expect(limiter.lockedFor('s1', 'ip1')).toBe(0);
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
