import { describe, expect, test } from 'bun:test';
import { IdleLruMap, TokenBucket } from './rate-limit';

describe('rate-limit', () => {
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
});
