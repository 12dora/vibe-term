import { describe, expect, test } from 'bun:test';
import {
  HUB_KEY_LOG_REQ_BURST,
  HUB_KEY_LOG_REQ_STATE_MAX,
  IdleLruMap,
  KeyLogReqLimiter,
  TokenBucket,
  WindowedLogBudget,
} from './uplink-rate-limit';

describe('uplink-rate-limit', () => {
  test('TokenBucket grants burst then denies until refill', () => {
    const bucket = new TokenBucket(60, 2);
    expect(bucket.take(1_000)).toBe(true);
    expect(bucket.take(1_000)).toBe(true);
    expect(bucket.take(1_000)).toBe(false);
    expect(bucket.take(1_000 + 1_000)).toBe(true);
    expect(bucket.take(1_000 + 1_000)).toBe(false);
  });

  test('IdleLruMap TTL, LRU eviction, trySet capacity, and touch recency', () => {
    const map = new IdleLruMap<number>(2, 1_000);
    expect(map.set('a', 1, 0)).toBe(1);
    expect(map.set('b', 2, 0)).toBe(2);
    expect(map.trySet('c', 3, 0)).toBeUndefined();
    map.touch('a', 10);
    map.set('c', 3, 10);
    expect(map.get('b', 10)).toBeUndefined();
    expect(map.get('a', 10)).toBe(1);
    expect(map.get('a', 10 + 1_000)).toBeUndefined();
    expect(map.size).toBe(0);
  });

  test('WindowedLogBudget windows, suppresses, and flushes on take', () => {
    const budget = new WindowedLogBudget(2, 1_000);
    expect(budget.wouldAllow(0)).toBe(true);
    expect(budget.take(0)).toBe(0);
    expect(budget.take(0)).toBe(0);
    expect(budget.wouldAllow(0)).toBe(false);
    budget.suppress();
    budget.suppress();
    expect(budget.take(1_001)).toBe(2);
    expect(budget.wouldAllow(1_001)).toBe(true);
  });

  test('key.log.req overflow bucket does not reset burst when cycling past capacity', () => {
    const limiter = new KeyLogReqLimiter({ max: HUB_KEY_LOG_REQ_STATE_MAX });
    const now = 1_000;
    let allowed = 0;
    for (let round = 0; round < HUB_KEY_LOG_REQ_BURST + 1; round++) {
      for (let i = 0; i < HUB_KEY_LOG_REQ_STATE_MAX + 1; i++) {
        const nodeId = i.toString(16).padStart(32, '0');
        if (limiter.take(nodeId, 'user-1', now)) allowed += 1;
      }
    }
    expect(allowed).toBe(HUB_KEY_LOG_REQ_STATE_MAX * HUB_KEY_LOG_REQ_BURST + HUB_KEY_LOG_REQ_BURST);
    expect(limiter.size).toBeGreaterThan(HUB_KEY_LOG_REQ_STATE_MAX);
  });

  test('overflow limiter is TTL-bounded, node-fair, and counted in size', () => {
    const limiter = new KeyLogReqLimiter({ max: 2, ttlMs: 1_000, burst: 2, ratePerMin: 0 });
    const t0 = 1_000;
    expect(limiter.take('n1', 'user-a', t0)).toBe(true);
    expect(limiter.take('n2', 'user-a', t0)).toBe(true);
    expect(limiter.take('n3', 'user-a', t0)).toBe(true);
    expect(limiter.take('n4', 'user-b', t0)).toBe(true);
    expect(limiter.size).toBeGreaterThan(2);
    expect(limiter.overflowUsers).toBeGreaterThan(0);

    expect(limiter.take('n3', 'user-a', t0)).toBe(true);
    expect(limiter.take('n3', 'user-a', t0)).toBe(false);
    expect(limiter.take('n4', 'user-b', t0)).toBe(true);
    expect(limiter.denied).toBeGreaterThan(0);

    limiter.take('n3', 'user-a', t0 + 2_000);
    expect(limiter.overflowUsers).toBe(0);
  });

  test('9th overflow node is rate_limited without starving an existing burst, then gains a slot after TTL', () => {
    const limiter = new KeyLogReqLimiter({
      max: 8,
      overflowMaxNodes: 8,
      burst: 2,
      ratePerMin: 0,
      ttlMs: 1_000,
    });
    const t0 = 1_000;
    for (let i = 0; i < 8; i++) {
      expect(limiter.take(`other-${i}`, 'user-other', t0)).toBe(true);
    }
    for (let i = 0; i < 8; i++) {
      expect(limiter.take(`a-${i}`, 'user-a', t0)).toBe(true);
    }
    expect(limiter.take('a-8', 'user-a', t0)).toBe(false);
    expect(limiter.take('a-0', 'user-a', t0)).toBe(true);
    expect(limiter.take('a-0', 'user-a', t0)).toBe(false);
    expect(limiter.take('a-8', 'user-a', t0 + 2_000)).toBe(true);
  });
});
