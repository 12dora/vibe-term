import { describe, expect, test } from 'bun:test';
import { isWindowMemorySampleStale, windowMemoryStaleAfterMs } from './window-memory-staleness';

const NOW = Date.UTC(2026, 8, 24, 12);

describe('windowMemoryStaleAfterMs', () => {
  test('3 个采样周期，不短于 3 个心跳，另加一分钟时钟余量', () => {
    expect(windowMemoryStaleAfterMs(5)).toBe(3 * 30_000 + 60_000);
    expect(windowMemoryStaleAfterMs(60)).toBe(3 * 60_000 + 60_000);
  });

  test('不知道周期时按上限 60 s 算', () => {
    expect(windowMemoryStaleAfterMs()).toBe(windowMemoryStaleAfterMs(60));
    expect(windowMemoryStaleAfterMs(null)).toBe(windowMemoryStaleAfterMs(60));
    expect(windowMemoryStaleAfterMs(0)).toBe(windowMemoryStaleAfterMs(60));
  });
});

describe('isWindowMemorySampleStale', () => {
  test('几天前的采样一律过期', () => {
    expect(isWindowMemorySampleStale({ sampledAt: NOW - 4 * 86_400_000, now: NOW })).toBe(true);
  });

  test('刚采的读数、以及时钟快了几十秒的读数都不算过期', () => {
    expect(isWindowMemorySampleStale({ sampledAt: NOW - 5_000, now: NOW, intervalSec: 5 })).toBe(
      false
    );
    expect(isWindowMemorySampleStale({ sampledAt: NOW + 40_000, now: NOW, intervalSec: 5 })).toBe(
      false
    );
  });

  test('超过阈值即过期', () => {
    const limit = windowMemoryStaleAfterMs(5);
    expect(isWindowMemorySampleStale({ sampledAt: NOW - limit, now: NOW, intervalSec: 5 })).toBe(
      false
    );
    expect(
      isWindowMemorySampleStale({ sampledAt: NOW - limit - 1, now: NOW, intervalSec: 5 })
    ).toBe(true);
  });

  test('网关标了 stale 或设备已断开，时间再新也算过期；字段缺席不影响判定', () => {
    expect(isWindowMemorySampleStale({ sampledAt: NOW, now: NOW, stale: true })).toBe(true);
    expect(isWindowMemorySampleStale({ sampledAt: NOW, now: NOW, connected: false })).toBe(true);
    expect(isWindowMemorySampleStale({ sampledAt: NOW, now: NOW, stale: undefined })).toBe(false);
  });

  test('没有采样时刻的读数不可信', () => {
    expect(isWindowMemorySampleStale({ sampledAt: 0, now: NOW })).toBe(true);
    expect(isWindowMemorySampleStale({ sampledAt: Number.NaN, now: NOW })).toBe(true);
  });
});
