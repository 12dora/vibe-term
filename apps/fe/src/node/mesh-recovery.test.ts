// 有界重试阶梯与「可见 / 网络恢复」订阅。

import { describe, expect, test } from 'bun:test';
import {
  RECOVERY_RETRY_MS,
  createRetryScheduler,
  isPageVisible,
  onPageRecovery,
} from './mesh-recovery';

function fakeTimers() {
  const pending: { fn: () => void; ms: number }[] = [];
  let cleared = 0;
  return {
    pending,
    get cleared() {
      return cleared;
    },
    setTimeoutFn: (fn: () => void, ms: number) => {
      pending.push({ fn, ms });
      return pending.length;
    },
    clearTimeoutFn: () => {
      cleared += 1;
    },
    run: () => {
      const next = pending.pop();
      next?.fn();
    },
  };
}

describe('createRetryScheduler', () => {
  test('按 1 / 3 / 10 秒排三次，之后不再排', () => {
    const timers = fakeTimers();
    const scheduler = createRetryScheduler(timers);
    const runs: number[] = [];
    const run = () => runs.push(runs.length);

    for (const expected of RECOVERY_RETRY_MS) {
      expect(scheduler.schedule(run)).toBe(true);
      expect(timers.pending.at(-1)?.ms).toBe(expected);
      timers.run();
    }
    expect(runs).toHaveLength(3);
    expect(scheduler.schedule(run)).toBe(false);
    expect(timers.pending).toHaveLength(0);
  });

  test('在途的一次不会被重复排', () => {
    const timers = fakeTimers();
    const scheduler = createRetryScheduler(timers);
    scheduler.schedule(() => undefined);
    scheduler.schedule(() => undefined);
    expect(timers.pending).toHaveLength(1);
    expect(scheduler.attempt).toBe(1);
  });

  test('reset 清掉在途定时器并把阶梯倒回起点', () => {
    const timers = fakeTimers();
    const scheduler = createRetryScheduler(timers);
    scheduler.schedule(() => undefined);
    scheduler.schedule(() => undefined);
    timers.run();
    scheduler.schedule(() => undefined);
    expect(timers.pending.at(-1)?.ms).toBe(RECOVERY_RETRY_MS[1]);

    scheduler.reset();
    expect(timers.cleared).toBe(1);
    expect(scheduler.attempt).toBe(0);
    scheduler.schedule(() => undefined);
    expect(timers.pending.at(-1)?.ms).toBe(RECOVERY_RETRY_MS[0]);
  });
});

describe('onPageRecovery', () => {
  test('没有 document（单测 / SSR）时返回空订阅，不抛', () => {
    expect(typeof globalThis.document).toBe('undefined');
    const stop = onPageRecovery(() => undefined);
    expect(() => stop()).not.toThrow();
    expect(isPageVisible()).toBe(true);
  });

  test('装上 document 后 visibilitychange→可见 与 online 各触发一次；隐藏不触发', () => {
    const listeners = new Map<string, Set<() => void>>();
    const doc = {
      visibilityState: 'visible',
      addEventListener: (type: string, fn: () => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners.get(type)?.delete(fn);
      },
    };
    Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
    try {
      let hits = 0;
      const stop = onPageRecovery(() => {
        hits += 1;
      });
      const fire = (type: string) => {
        for (const fn of listeners.get(type) ?? []) fn();
      };

      fire('visibilitychange');
      expect(hits).toBe(1);
      expect(isPageVisible()).toBe(true);

      doc.visibilityState = 'hidden';
      fire('visibilitychange');
      expect(hits).toBe(1);
      expect(isPageVisible()).toBe(false);

      doc.visibilityState = 'visible';
      globalThis.dispatchEvent(new Event('online'));
      expect(hits).toBe(2);

      stop();
      fire('visibilitychange');
      globalThis.dispatchEvent(new Event('online'));
      expect(hits).toBe(2);
    } finally {
      Reflect.deleteProperty(globalThis, 'document');
    }
  });
});
