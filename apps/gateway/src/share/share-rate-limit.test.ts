import { describe, expect, test } from 'bun:test';
import { UNKNOWN_CLIENT_KEY } from '../mesh/client-ip';
import {
  SHARE_LOGIN_BACKOFF_CAP_MS,
  SHARE_LOGIN_BACKOFF_START_MS,
  SHARE_LOGIN_BUSY_RETRY_MS,
  SHARE_LOGIN_GRACE_FAILURES,
  SHARE_LOGIN_MAX_CONCURRENT,
  SHARE_LOGIN_SHARE_MAX_FAILURES,
  SHARE_LOGIN_SHARE_SLOWDOWN_MS,
  SHARE_LOGIN_SHARE_WINDOW_MS,
  SHARE_LOGIN_SUCCESS_MEMORY_MS,
  SHARE_VERIFY_MAX_INFLIGHT,
  ShareLoginLimiter,
  shareLoginBackoffMs,
} from './share-rate-limit';

function rotatingIp(index: number): string {
  return `198.51.${Math.floor(index / 200)}.${index % 200}`;
}

function failTimes(limiter: ShareLoginLimiter, shareId: string, ip: string, times: number): void {
  for (let i = 0; i < times; i++) limiter.recordFailure(shareId, ip);
}

describe('shareLoginBackoffMs', () => {
  test('前 3 次失败不退避，之后 2 s、4 s、8 s，封顶 15 min', () => {
    expect(shareLoginBackoffMs(0)).toBe(0);
    expect(shareLoginBackoffMs(2)).toBe(0);
    expect(shareLoginBackoffMs(3)).toBe(SHARE_LOGIN_BACKOFF_START_MS);
    expect(shareLoginBackoffMs(4)).toBe(4_000);
    expect(shareLoginBackoffMs(5)).toBe(8_000);
    expect(shareLoginBackoffMs(12)).toBe(SHARE_LOGIN_BACKOFF_CAP_MS);
    expect(shareLoginBackoffMs(40)).toBe(SHARE_LOGIN_BACKOFF_CAP_MS);
  });
});

describe('ShareLoginLimiter', () => {
  test('宽限期内不锁定，第 3 次失败后 retryAfter 按退避递减', () => {
    let now = 1_000;
    const limiter = new ShareLoginLimiter(() => now);
    failTimes(limiter, 's1', '203.0.113.1', SHARE_LOGIN_GRACE_FAILURES - 1);
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBe(0);
    limiter.recordFailure('s1', '203.0.113.1');
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBe(SHARE_LOGIN_BACKOFF_START_MS);
    now += 500;
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBe(SHARE_LOGIN_BACKOFF_START_MS - 500);
    now += SHARE_LOGIN_BACKOFF_START_MS;
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBe(0);
    limiter.recordFailure('s1', '203.0.113.1');
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBe(4_000);
  });

  test('按分享 + IP 分别计数', () => {
    const limiter = new ShareLoginLimiter(() => 0);
    failTimes(limiter, 's1', '203.0.113.1', SHARE_LOGIN_GRACE_FAILURES);
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBeGreaterThan(0);
    expect(limiter.lockedFor('s1', '203.0.113.2')).toBe(0);
    expect(limiter.lockedFor('s2', '203.0.113.1')).toBe(0);
  });

  test('退避封顶 15 min，成功只清该 IP 桶', () => {
    let now = 0;
    const limiter = new ShareLoginLimiter(() => now);
    failTimes(limiter, 's1', '203.0.113.1', 12);
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBe(SHARE_LOGIN_BACKOFF_CAP_MS);
    now += SHARE_LOGIN_BACKOFF_CAP_MS - 1;
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBe(1);
    now += 1;
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBe(0);
    expect(limiter.begin('s1', '203.0.113.1')).toEqual({ ok: true });
    limiter.settle('s1', '203.0.113.1', true);
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBe(0);
  });

  test('begin 预占额度：在途尝试计入并发上限', () => {
    const limiter = new ShareLoginLimiter(() => 0);
    for (let i = 0; i < SHARE_LOGIN_MAX_CONCURRENT; i++) {
      expect(limiter.begin('s1', '203.0.113.1')).toEqual({ ok: true });
    }
    expect(limiter.begin('s1', '203.0.113.1').ok).toBe(false);
    for (let i = 0; i < SHARE_LOGIN_MAX_CONCURRENT; i++) {
      limiter.settle('s1', '203.0.113.1', false);
    }
    expect(limiter.begin('s1', '203.0.113.1')).toEqual({ ok: true });
    limiter.settle('s1', '203.0.113.1', false);
    expect(limiter.begin('s1', '203.0.113.1').ok).toBe(false);
  });

  test('settle 成功即清空该分享 + IP 的失败记录', () => {
    const limiter = new ShareLoginLimiter(() => 0);
    failTimes(limiter, 's1', '203.0.113.1', SHARE_LOGIN_GRACE_FAILURES);
    expect(limiter.begin('s1', '203.0.113.1').ok).toBe(false);
    limiter.reset('s1', '203.0.113.1');
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBe(0);
    expect(limiter.begin('s1', '203.0.113.1')).toEqual({ ok: true });
    limiter.settle('s1', '203.0.113.1', true);
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBe(0);
  });

  test('reset / clear 清空计数', () => {
    const limiter = new ShareLoginLimiter(() => 0);
    failTimes(limiter, 's1', '203.0.113.1', SHARE_LOGIN_GRACE_FAILURES);
    limiter.reset('s1', '203.0.113.1');
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBe(0);
    limiter.recordFailure('s1', '203.0.113.1');
    limiter.clear();
    expect(limiter.size).toBe(0);
  });

  test('50 个轮换 IP 失败后，干净 IP 立即校验，脏 IP 降速', () => {
    let now = 0;
    const limiter = new ShareLoginLimiter(() => now);
    for (let i = 0; i < SHARE_LOGIN_SHARE_MAX_FAILURES; i++) {
      const ip = rotatingIp(i);
      expect(limiter.begin('s1', ip)).toEqual({ ok: true });
      limiter.settle('s1', ip, false);
    }
    expect(limiter.begin('s1', '203.0.113.200')).toEqual({ ok: true });
    limiter.settle('s1', '203.0.113.200', true);
    expect(limiter.begin('s1', rotatingIp(0))).toEqual({
      ok: false,
      reason: 'locked',
      retryAfterMs: SHARE_LOGIN_SHARE_SLOWDOWN_MS,
    });
    expect(limiter.begin('s2', '203.0.113.200')).toEqual({ ok: true });
    limiter.settle('s2', '203.0.113.200', true);
    now += SHARE_LOGIN_SHARE_SLOWDOWN_MS;
    expect(limiter.lockedFor('s1', rotatingIp(0))).toBe(0);
    expect(limiter.begin('s1', rotatingIp(0))).toEqual({ ok: true });
    expect(limiter.begin('s1', rotatingIp(1)).ok).toBe(false);
    limiter.settle('s1', rotatingIp(0), true);
    now += 1_000;
    expect(limiter.lockedFor('s1', rotatingIp(1))).toBe(SHARE_LOGIN_SHARE_SLOWDOWN_MS - 1_000);
    now += SHARE_LOGIN_SHARE_WINDOW_MS;
    expect(limiter.lockedFor('s1', rotatingIp(1))).toBe(0);
  });

  test('某 IP 的成功不清其它 IP 的退避，也不靠分享桶拖住干净 IP', () => {
    const limiter = new ShareLoginLimiter(() => 0);
    failTimes(limiter, 's1', '203.0.113.1', SHARE_LOGIN_GRACE_FAILURES);
    expect(limiter.begin('s1', '203.0.113.8')).toEqual({ ok: true });
    limiter.settle('s1', '203.0.113.8', true);
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBe(SHARE_LOGIN_BACKOFF_START_MS);
    expect(limiter.lockedFor('s1', '203.0.113.9')).toBe(0);
  });

  test('近 24 h 成功过的 IP 在分享降速后仍视为干净', () => {
    let now = 0;
    const limiter = new ShareLoginLimiter(() => now);
    expect(limiter.begin('s1', '203.0.113.1')).toEqual({ ok: true });
    limiter.settle('s1', '203.0.113.1', true);
    limiter.recordFailure('s1', '203.0.113.1');
    for (let i = 0; i < SHARE_LOGIN_SHARE_MAX_FAILURES; i++) {
      limiter.recordFailure('s1', rotatingIp(i));
    }
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBe(0);
    expect(limiter.begin('s1', '203.0.113.1')).toEqual({ ok: true });
    limiter.settle('s1', '203.0.113.1', false);
    now += SHARE_LOGIN_SUCCESS_MEMORY_MS;
    for (let i = 0; i < SHARE_LOGIN_SHARE_MAX_FAILURES; i++) {
      limiter.recordFailure('s1', rotatingIp(200 + i));
    }
    expect(limiter.begin('s1', '203.0.113.1').ok).toBe(false);
  });

  test('unknown 来源一律当脏 IP，不享受干净规则', () => {
    const limiter = new ShareLoginLimiter(() => 0);
    for (let i = 0; i < SHARE_LOGIN_SHARE_MAX_FAILURES; i++) {
      limiter.recordFailure('s1', rotatingIp(i));
    }
    expect(limiter.lockedFor('s1', UNKNOWN_CLIENT_KEY)).toBe(SHARE_LOGIN_SHARE_SLOWDOWN_MS);
    expect(limiter.begin('s1', UNKNOWN_CLIENT_KEY)).toEqual({
      ok: false,
      reason: 'locked',
      retryAfterMs: SHARE_LOGIN_SHARE_SLOWDOWN_MS,
    });
    limiter.reset('s1', UNKNOWN_CLIENT_KEY);
    expect(limiter.begin('s1', UNKNOWN_CLIENT_KEY).ok).toBe(false);
  });

  test('IP 键超过上限时按 LRU 淘汰最旧条目', () => {
    const limiter = new ShareLoginLimiter(() => 0, 3);
    failTimes(limiter, 's1', '203.0.113.1', SHARE_LOGIN_GRACE_FAILURES);
    failTimes(limiter, 's1', '203.0.113.2', SHARE_LOGIN_GRACE_FAILURES);
    failTimes(limiter, 's1', '203.0.113.3', SHARE_LOGIN_GRACE_FAILURES);
    expect(limiter.size).toBe(3);
    failTimes(limiter, 's1', '203.0.113.4', SHARE_LOGIN_GRACE_FAILURES);
    expect(limiter.size).toBe(3);
    expect(limiter.lockedFor('s1', '203.0.113.1')).toBe(0);
    expect(limiter.lockedFor('s1', '203.0.113.4')).toBe(SHARE_LOGIN_BACKOFF_START_MS);
  });

  test('the concurrency cap reports busy, not locked', () => {
    const limiter = new ShareLoginLimiter(() => 0);
    for (let i = 0; i < SHARE_LOGIN_MAX_CONCURRENT; i++) limiter.begin('s1', '203.0.113.1');
    expect(limiter.begin('s1', '203.0.113.1')).toEqual({
      ok: false,
      reason: 'busy',
      retryAfterMs: SHARE_LOGIN_BUSY_RETRY_MS,
    });
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
    failTimes(limiter, 's1', '2001:db8:1:2::1', SHARE_LOGIN_GRACE_FAILURES);
    expect(limiter.lockedFor('s1', '2001:db8:1:2:ffff::1')).toBeGreaterThan(0);
    expect(limiter.lockedFor('s1', '2001:db8:1:3::1')).toBe(0);
  });
});
