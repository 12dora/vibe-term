import { describe, expect, test } from 'bun:test';
import {
  WINDOW_MEMORY_FRAME_STALE_MS,
  WINDOW_MEMORY_REPLAY_STALE_MS,
  isWindowMemoryFrameStale,
  isWindowMemorySampleStale,
  windowMemoryFrameStaleSince,
  windowMemoryStaleAfterMs,
} from './window-memory-staleness';

const NOW = Date.UTC(2026, 8, 24, 12);

describe('windowMemoryStaleAfterMs', () => {
  test('3 个采样周期，不短于 3 个心跳', () => {
    expect(windowMemoryStaleAfterMs(5)).toBe(3 * 30_000);
    expect(windowMemoryStaleAfterMs(60)).toBe(3 * 60_000);
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

  test('退回跨机比较时超过阈值（另加一分钟时钟余量）即过期', () => {
    const limit = windowMemoryStaleAfterMs(5) + 60_000;
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

describe('isWindowMemorySampleStale：网关给了读数年龄', () => {
  test('按年龄判，不拿节点时钟比浏览器时钟', () => {
    const limit = windowMemoryStaleAfterMs(5);
    const slowNode = NOW - 10 * 60_000;
    expect(
      isWindowMemorySampleStale({
        sampledAt: slowNode,
        now: NOW,
        intervalSec: 5,
        sampledAgeMs: 3_000,
      })
    ).toBe(false);
    const fastNode = NOW + 10 * 60_000;
    expect(
      isWindowMemorySampleStale({
        sampledAt: fastNode,
        now: NOW,
        intervalSec: 5,
        sampledAgeMs: limit + 1,
      })
    ).toBe(true);
    expect(
      isWindowMemorySampleStale({
        sampledAt: fastNode,
        now: NOW,
        intervalSec: 5,
        sampledAgeMs: limit,
      })
    ).toBe(false);
  });

  test('stale 仍然压过年龄；年龄不合法时退回跨机比较', () => {
    expect(
      isWindowMemorySampleStale({ sampledAt: NOW, now: NOW, stale: true, sampledAgeMs: 0 })
    ).toBe(true);
    for (const sampledAgeMs of [-1, Number.NaN, '5', null]) {
      expect(
        isWindowMemorySampleStale({ sampledAt: NOW - 4 * 86_400_000, now: NOW, sampledAgeMs })
      ).toBe(true);
    }
  });
});

describe('isWindowMemoryFrameStale', () => {
  const frame = (receivedAt: number, sampledAt = receivedAt) => ({ receivedAt, sampledAt });

  test('按本地收到多久判：两次心跳内新鲜，超过即过期', () => {
    expect(isWindowMemoryFrameStale(frame(NOW - WINDOW_MEMORY_FRAME_STALE_MS), NOW)).toBe(false);
    expect(isWindowMemoryFrameStale(frame(NOW - WINDOW_MEMORY_FRAME_STALE_MS - 1), NOW)).toBe(true);
  });

  test('没有收到时刻的帧不可信', () => {
    expect(isWindowMemoryFrameStale(frame(0), NOW)).toBe(true);
    expect(isWindowMemoryFrameStale(frame(Number.NaN), NOW)).toBe(true);
  });

  test('旧网关连上就重放几天前的缓存读数：刚收到也立即过期', () => {
    expect(isWindowMemoryFrameStale(frame(NOW, NOW - 4 * 86_400_000), NOW)).toBe(true);
    expect(isWindowMemoryFrameStale(frame(NOW, NOW - WINDOW_MEMORY_REPLAY_STALE_MS - 1), NOW)).toBe(
      true
    );
  });

  test('节点时钟慢或快几分钟、帧按时到：照常新鲜', () => {
    expect(isWindowMemoryFrameStale(frame(NOW, NOW - 5 * 60_000), NOW)).toBe(false);
    expect(isWindowMemoryFrameStale(frame(NOW, NOW - WINDOW_MEMORY_REPLAY_STALE_MS), NOW)).toBe(
      false
    );
    expect(isWindowMemoryFrameStale(frame(NOW, NOW + 5 * 60_000), NOW)).toBe(false);
    expect(isWindowMemoryFrameStale(frame(NOW - 30_000, NOW - 8 * 60_000), NOW)).toBe(false);
  });

  test('采样时刻缺失时只按收到时刻判', () => {
    expect(isWindowMemoryFrameStale(frame(NOW, Number.NaN), NOW)).toBe(false);
  });
});

describe('windowMemoryFrameStaleSince', () => {
  test('重放帧按采样时刻，其余按收到时刻', () => {
    const old = NOW - 3 * 86_400_000;
    expect(windowMemoryFrameStaleSince({ receivedAt: NOW, sampledAt: old })).toBe(old);
    expect(windowMemoryFrameStaleSince({ receivedAt: NOW, sampledAt: NOW - 60_000 })).toBe(NOW);
  });
});
