import { describe, expect, test } from 'bun:test';
import {
  SHARE_LOGIN_BUSY_RETRY_MS,
  SHARE_LOGIN_LOCK_MS,
  SHARE_LOGIN_MAX_CONCURRENT,
  SHARE_LOGIN_MAX_FAILURES,
  SHARE_LOGIN_SHARE_MAX_FAILURES,
  SHARE_LOGIN_SHARE_SLOWDOWN_MS,
  SHARE_LOGIN_SHARE_WINDOW_MS,
  SHARE_LOGIN_WINDOW_MS,
  SHARE_VERIFY_MAX_INFLIGHT,
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

  test('rotating source IPs reach the per-share bucket, which then allows one verification per interval', () => {
    let now = 0;
    const limiter = new ShareLoginLimiter(() => now);
    for (let i = 0; i < SHARE_LOGIN_SHARE_MAX_FAILURES; i++) {
      const ip = `198.51.${Math.floor(i / 200)}.${i % 200}`;
      expect(limiter.begin('s1', ip)).toEqual({ ok: true });
      limiter.settle('s1', ip, false);
    }
    expect(limiter.begin('s1', '203.0.113.200')).toEqual({
      ok: false,
      reason: 'locked',
      retryAfterMs: SHARE_LOGIN_SHARE_SLOWDOWN_MS,
    });
    expect(limiter.begin('s2', '203.0.113.200')).toEqual({ ok: true });
    limiter.settle('s2', '203.0.113.200', true);
    now += SHARE_LOGIN_SHARE_SLOWDOWN_MS;
    expect(limiter.lockedFor('s1', '203.0.113.200')).toBe(0);
    expect(limiter.begin('s1', '203.0.113.200')).toEqual({ ok: true });
    expect(limiter.begin('s1', '203.0.113.201').ok).toBe(false);
    limiter.settle('s1', '203.0.113.200', true);
    now += 1_000;
    expect(limiter.lockedFor('s1', '203.0.113.201')).toBe(SHARE_LOGIN_SHARE_SLOWDOWN_MS - 1_000);
    now += SHARE_LOGIN_SHARE_WINDOW_MS;
    expect(limiter.lockedFor('s1', '203.0.113.201')).toBe(0);
  });

  test('the concurrency cap reports busy, not locked', () => {
    const limiter = new ShareLoginLimiter(() => 0);
    for (let i = 0; i < SHARE_LOGIN_MAX_CONCURRENT; i++) limiter.begin('s1', 'ip1');
    expect(limiter.begin('s1', 'ip1')).toEqual({
      ok: false,
      reason: 'busy',
      retryAfterMs: SHARE_LOGIN_BUSY_RETRY_MS,
    });
  });

  test('a successful login does not clear the per-share bucket', () => {
    const limiter = new ShareLoginLimiter(() => 0);
    for (let i = 0; i < SHARE_LOGIN_SHARE_MAX_FAILURES - 1; i++) {
      limiter.recordFailure('s1', `198.51.100.${i}`);
    }
    expect(limiter.begin('s1', '203.0.113.1')).toEqual({ ok: true });
    limiter.settle('s1', '203.0.113.1', true);
    limiter.recordFailure('s1', '203.0.113.2');
    expect(limiter.lockedFor('s1', '203.0.113.3')).toBeGreaterThan(0);
  });

  test('process-wide verification cap rejects immediately across shares and IPs', () => {
    const limiter = new ShareLoginLimiter(() => 0);
    for (let i = 0; i < SHARE_VERIFY_MAX_INFLIGHT; i++) {
      expect(limiter.begin(`s${i}`, `198.51.100.${i}`)).toEqual({ ok: true });
    }
    const busy = limiter.begin('other', '203.0.113.9');
    expect(busy.ok).toBe(false);
    limiter.settle('s0', '198.51.100.0', false);
    expect(limiter.begin('other', '203.0.113.9')).toEqual({ ok: true });
  });

  test('IPv6 sources inside one /64 share a bucket', () => {
    const limiter = new ShareLoginLimiter(() => 0);
    for (let i = 0; i < SHARE_LOGIN_MAX_FAILURES; i++) {
      limiter.recordFailure('s1', `2001:db8:1:2::${(i + 1).toString(16)}`);
    }
    expect(limiter.lockedFor('s1', '2001:db8:1:2:ffff::1')).toBeGreaterThan(0);
    expect(limiter.lockedFor('s1', '2001:db8:1:3::1')).toBe(0);
  });
});
