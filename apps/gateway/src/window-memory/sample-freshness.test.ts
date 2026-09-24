import { describe, expect, test } from 'bun:test';

import { isMemorySampleStale, memorySampleStaleAfterMs } from './sample-freshness';

describe('isMemorySampleStale', () => {
  test('unsampled and a single slow tick are not stale', () => {
    expect(isMemorySampleStale(0, 1_000_000, 5)).toBe(false);
    expect(isMemorySampleStale(1_000, 1_000 + 59_000, 5)).toBe(false);
    expect(memorySampleStaleAfterMs(5)).toBe(60_000);
  });

  test('older than the floor (or 6 intervals, whichever is later) is stale', () => {
    expect(isMemorySampleStale(1_000, 1_000 + 60_001, 5)).toBe(true);
    expect(memorySampleStaleAfterMs(60)).toBe(360_000);
    expect(isMemorySampleStale(1_000, 1_000 + 120_000, 60)).toBe(false);
    expect(isMemorySampleStale(1_000, 1_000 + 360_001, 60)).toBe(true);
  });
});
