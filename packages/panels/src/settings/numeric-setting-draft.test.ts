// 终端字号 / 行高的延后提交：每提交一次都会重建全部已挂载的 ghostty 实例，
// 所以「按住上下箭头只提交一次」「失焦立刻提交且只提交一次」是硬要求。

import { describe, expect, test } from 'bun:test';
import {
  NUMERIC_DRAFT_COMMIT_MS,
  createDeferredCommit,
  parseNumericSetting,
} from './numeric-setting-draft';

describe('parseNumericSetting', () => {
  test('区间内的数才是可提交值', () => {
    expect(parseNumericSetting('12', 8, 28)).toBe(12);
    expect(parseNumericSetting('8', 8, 28)).toBe(8);
    expect(parseNumericSetting('28', 8, 28)).toBe(28);
    expect(parseNumericSetting('1.4', 1, 2)).toBe(1.4);
  });

  test('空串 / 非数 / 越界一律拒绝', () => {
    expect(parseNumericSetting('', 8, 28)).toBeNull();
    expect(parseNumericSetting('   ', 8, 28)).toBeNull();
    expect(parseNumericSetting('abc', 8, 28)).toBeNull();
    expect(parseNumericSetting('7', 8, 28)).toBeNull();
    expect(parseNumericSetting('29', 8, 28)).toBeNull();
  });
});

/** 手动时钟：只跑到点的定时器，断言「攒了几次、写了几次」。 */
function manualClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;

  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    seq += 1;
    pending.set(seq, { at: now + (ms ?? 0), fn });
    return seq as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    pending.delete(handle as number);
  }) as typeof clearTimeout;

  return {
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at > now) continue;
        pending.delete(id);
        entry.fn();
      }
    },
    armed: () => pending.size,
    restore() {
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
    },
  };
}

describe('createDeferredCommit', () => {
  test('窗口内连续 schedule 只提交最后一个值一次', () => {
    const clock = manualClock();
    try {
      const seen: number[] = [];
      const deferred = createDeferredCommit<number>((value) => seen.push(value));

      for (const size of [13, 14, 15, 16, 17]) {
        deferred.schedule(size);
        clock.advance(30);
      }
      expect(seen).toEqual([]);

      clock.advance(NUMERIC_DRAFT_COMMIT_MS);
      expect(seen).toEqual([17]);
      expect(clock.armed()).toBe(0);
    } finally {
      clock.restore();
    }
  });

  test('flush（失焦 / 回车）立刻提交，且到点的定时器不再重复提交', () => {
    const clock = manualClock();
    try {
      const seen: number[] = [];
      const deferred = createDeferredCommit<number>((value) => seen.push(value));

      deferred.schedule(16);
      deferred.flush();
      expect(seen).toEqual([16]);

      clock.advance(NUMERIC_DRAFT_COMMIT_MS * 4);
      expect(seen).toEqual([16]);
    } finally {
      clock.restore();
    }
  });

  test('没有待提交值时 flush 无副作用', () => {
    const clock = manualClock();
    try {
      const seen: number[] = [];
      const deferred = createDeferredCommit<number>((value) => seen.push(value));

      deferred.flush();
      deferred.flush();
      expect(seen).toEqual([]);
    } finally {
      clock.restore();
    }
  });

  test('cancel（卸载）丢掉待提交值', () => {
    const clock = manualClock();
    try {
      const seen: number[] = [];
      const deferred = createDeferredCommit<number>((value) => seen.push(value));

      deferred.schedule(20);
      deferred.cancel();
      clock.advance(NUMERIC_DRAFT_COMMIT_MS * 4);

      expect(seen).toEqual([]);
      expect(clock.armed()).toBe(0);
    } finally {
      clock.restore();
    }
  });

  test('提交后再 schedule 走的是新的窗口', () => {
    const clock = manualClock();
    try {
      const seen: number[] = [];
      const deferred = createDeferredCommit<number>((value) => seen.push(value));

      deferred.schedule(12);
      clock.advance(NUMERIC_DRAFT_COMMIT_MS);
      deferred.schedule(18);
      clock.advance(NUMERIC_DRAFT_COMMIT_MS);

      expect(seen).toEqual([12, 18]);
    } finally {
      clock.restore();
    }
  });
});
