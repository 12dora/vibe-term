// 轮询 store 骨架本身的单测：订阅面 / 重置钩子、节流与可见性门、单例引用计数。
// `mesh-nodes` / `mesh-hubs` 两份 store 的行为断言仍留在各自的 spec 里。

import { describe, expect, test } from 'bun:test';
import {
  type PollingTimingOptions,
  createPollingHandle,
  createStateStore,
  startPollingLoop,
} from './create-polling-store';

interface Counter {
  value: number;
}

describe('createStateStore', () => {
  test('set 合并补丁并通知订阅方，取消订阅后不再收到', () => {
    const store = createStateStore<Counter & { label: string }>({ value: 0, label: 'a' });
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });

    store.set({ value: 1 });
    expect(store.get()).toEqual({ value: 1, label: 'a' });
    expect(notified).toBe(1);

    unsubscribe();
    store.set({ value: 2 });
    expect(store.get().value).toBe(2);
    expect(notified).toBe(1);
  });

  test('reset 回到初始状态、跑 onReset、并通知一次', () => {
    let cleared = 0;
    const store = createStateStore<Counter>({ value: 0 }, () => {
      cleared += 1;
    });
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    store.set({ value: 9 });
    store.reset();
    expect(store.get()).toEqual({ value: 0 });
    expect(cleared).toBe(1);
    expect(notified).toBe(2);
  });
});

function loopHarness() {
  const state = {
    refreshes: 0,
    scheduled: 0,
    intervalMs: 0,
    tick: null as (() => void) | null,
    delays: [] as { fn: () => void; ms: number }[],
    onVisibilityChange: null as (() => void) | null,
    hidden: false,
    now: 1_000_000,
  };
  const options: PollingTimingOptions = {
    schedule: (fn, ms) => {
      state.scheduled += 1;
      state.intervalMs = ms;
      state.tick = fn;
      return () => {
        state.tick = null;
      };
    },
    delay: (fn, ms) => {
      const entry = { fn, ms };
      state.delays.push(entry);
      return () => {
        state.delays = state.delays.filter((item) => item !== entry);
      };
    },
    visibility: {
      hidden: () => state.hidden,
      subscribe: (listener) => {
        state.onVisibilityChange = listener;
        return () => {
          state.onVisibilityChange = null;
        };
      },
    },
    now: () => state.now,
  };
  return { state, options };
}

describe('startPollingLoop', () => {
  test('挂载即拉一次，兜底拍用缺省间隔，隐藏期间跳过这一拍', () => {
    const { state, options } = loopHarness();
    const stop = startPollingLoop(options, {
      defaultIntervalMs: 30_000,
      defaultThrottleMs: 0,
      refresh: () => {
        state.refreshes += 1;
      },
    });

    expect(state.refreshes).toBe(1);
    expect(state.intervalMs).toBe(30_000);

    state.hidden = true;
    state.tick?.();
    expect(state.refreshes).toBe(1);

    state.hidden = false;
    state.tick?.();
    expect(state.refreshes).toBe(2);

    stop();
    expect(state.tick).toBeNull();
    expect(state.onVisibilityChange).toBeNull();
  });

  test('节流窗口内的多次 requestRefresh 只排一次延时补拉', () => {
    const { state, options } = loopHarness();
    let request: () => void = () => {};
    startPollingLoop(options, {
      defaultIntervalMs: 30_000,
      defaultThrottleMs: 2_000,
      refresh: () => {
        state.refreshes += 1;
      },
      wire: (controls) => {
        request = controls.requestRefresh;
        return () => undefined;
      },
    });

    expect(state.refreshes).toBe(1);
    request();
    request();
    expect(state.delays).toHaveLength(1);
    expect(state.delays[0].ms).toBe(2_000);

    state.delays[0].fn();
    expect(state.refreshes).toBe(2);
  });

  test('intervalMs <= 0 只接线事件源，不装定时器也不订阅可见性', () => {
    const { state, options } = loopHarness();
    let wired = 0;
    const stop = startPollingLoop(
      { ...options, intervalMs: 0 },
      {
        defaultIntervalMs: 30_000,
        defaultThrottleMs: 0,
        refresh: () => {
          state.refreshes += 1;
        },
        wire: () => {
          wired += 1;
          return () => {
            wired -= 1;
          };
        },
      }
    );

    expect(state.scheduled).toBe(0);
    expect(state.onVisibilityChange).toBeNull();
    expect(state.refreshes).toBe(1);
    expect(wired).toBe(1);

    stop();
    expect(wired).toBe(0);
  });

  test('回到前台走 onVisible，隐藏时不触发', () => {
    const { state, options } = loopHarness();
    let visible = 0;
    startPollingLoop(options, {
      defaultIntervalMs: 30_000,
      defaultThrottleMs: 0,
      refresh: () => {
        state.refreshes += 1;
      },
      onVisible: () => {
        visible += 1;
      },
    });

    state.hidden = true;
    state.onVisibilityChange?.();
    expect(visible).toBe(0);

    state.hidden = false;
    state.onVisibilityChange?.();
    expect(visible).toBe(1);
  });
});

describe('createPollingHandle', () => {
  test('只起一条回路，最后一个归还才停，归还幂等', () => {
    let started = 0;
    let stopped = 0;
    const acquire = createPollingHandle<{ tag: string }>(() => {
      started += 1;
      return () => {
        stopped += 1;
      };
    });

    const first = acquire({ tag: 'a' });
    const second = acquire({ tag: 'b' });
    expect(started).toBe(1);

    first();
    first();
    expect(stopped).toBe(0);

    second();
    expect(stopped).toBe(1);

    acquire({ tag: 'c' });
    expect(started).toBe(2);
  });
});
