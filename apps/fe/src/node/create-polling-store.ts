// 宿主级单例轮询 store 的公共骨架：`mesh-nodes` 与 `mesh-hubs` 两份 store 共用。
//
// 两边真正的分歧只有三处——刷新做什么、订阅哪些事件源、回到前台补不补，其余（模块级状态 +
// useSyncExternalStore 订阅面、事件补拉的节流窗口、隐藏页跳拍的可见性门、单例引用计数）
// 逐处相同，抽到这里一份实现。

import { type PageVisibility, browserVisibility } from './hub-polling';

/** 定时器注入口：装上返回取消函数（`setInterval` / `setTimeout` 两种都是这个形状）。 */
export type CancelableSchedule = (fn: () => void, ms: number) => () => void;

export interface StateStore<TState> {
  get: () => TState;
  set: (patch: Partial<TState>) => void;
  subscribe: (listener: () => void) => () => void;
  /** 回到初始状态并通知订阅方；模块自己的在途标记由 `onReset` 清。 */
  reset: () => void;
}

/**
 * 模块级状态 + 订阅面。`get` 返回的引用只在 `set` 时变化，可直接喂 `useSyncExternalStore`。
 */
export function createStateStore<TState extends object>(
  initial: TState,
  onReset?: () => void
): StateStore<TState> {
  let state = initial;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: () => {
      state = initial;
      onReset?.();
      notify();
    },
  };
}

/** 两份 store 的轮询选项里可注入的公共部分（测试用假定时器 / 假可见性接管回路）。 */
export interface PollingTimingOptions {
  intervalMs?: number;
  /** 事件补拉的节流窗口；`<=0` 表示不节流。 */
  throttleMs?: number;
  schedule?: CancelableSchedule;
  delay?: CancelableSchedule;
  visibility?: PageVisibility;
  now?: () => number;
}

export interface PollingControls {
  /** 立刻刷新一次并重置节流窗口。 */
  runRefresh: () => void;
  /** 节流刷新：窗口内的多次触发只换来一次刷新（窗口未满时排一次延时）。 */
  requestRefresh: () => void;
}

export interface PollingLoopSpec {
  defaultIntervalMs: number;
  defaultThrottleMs: number;
  /** 一次真正的刷新动作。 */
  refresh: () => void;
  /** 订阅事件源，返回取消函数；在首次刷新之前接线，断流期间的事件才不会漏。 */
  wire?: (controls: PollingControls) => () => void;
  /** 兜底拍（页面可见时）的动作；缺省立刻刷新。 */
  tick?: (controls: PollingControls) => void;
  /** 页面重新可见时的动作；缺省走节流补拉。 */
  onVisible?: (controls: PollingControls) => void;
  /**
   * 取用时页面已隐藏就跳过首拍，等回到前台再补。
   * 只对装了定时器的回路（`intervalMs > 0`）生效；缺省 false，既有 store 行为不变。
   */
  deferFirstRefreshWhenHidden?: boolean;
}

const intervalSchedule: CancelableSchedule = (fn, ms) => {
  const timer = setInterval(fn, ms);
  return () => clearInterval(timer);
};

const timeoutSchedule: CancelableSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/**
 * 轮询回路本体：
 *  - 接线事件源 → 首次刷新 → 装兜底定时器与可见性订阅；
 *  - 页面隐藏期间跳过这一拍（手机锁屏 / 切走时不该再唤醒射频）；
 *  - `intervalMs <= 0` 表示只靠事件驱动，不装定时器也不订阅可见性。
 */
export function startPollingLoop(options: PollingTimingOptions, spec: PollingLoopSpec): () => void {
  const intervalMs = options.intervalMs ?? spec.defaultIntervalMs;
  const throttleMs = options.throttleMs ?? spec.defaultThrottleMs;
  const now = options.now ?? Date.now;
  const visibility = options.visibility ?? browserVisibility();
  const schedule = options.schedule ?? intervalSchedule;
  const delay = options.delay ?? timeoutSchedule;

  let lastRefreshAt = Number.NEGATIVE_INFINITY;
  let cancelPending: (() => void) | null = null;

  const runRefresh = () => {
    lastRefreshAt = now();
    spec.refresh();
  };

  const requestRefresh = () => {
    if (cancelPending) return;
    const elapsed = now() - lastRefreshAt;
    if (elapsed >= throttleMs) {
      runRefresh();
      return;
    }
    cancelPending = delay(() => {
      cancelPending = null;
      runRefresh();
    }, throttleMs - elapsed);
  };

  const controls: PollingControls = { runRefresh, requestRefresh };
  const stopWire = spec.wire?.(controls);

  // 隐藏页跳首拍只在装了定时器时成立：纯事件驱动的回路没有可见性订阅来补这一拍。
  const skipFirst =
    spec.deferFirstRefreshWhenHidden === true && intervalMs > 0 && visibility.hidden();
  if (!skipFirst) runRefresh();

  const stopEventHooks = () => {
    stopWire?.();
    cancelPending?.();
    cancelPending = null;
  };
  if (intervalMs <= 0) return stopEventHooks;

  const cancelTimer = schedule(() => {
    if (visibility.hidden()) return;
    if (spec.tick) spec.tick(controls);
    else runRefresh();
  }, intervalMs);
  const unsubscribe = visibility.subscribe(() => {
    if (visibility.hidden()) return;
    if (spec.onVisible) spec.onVisible(controls);
    else requestRefresh();
  });
  return () => {
    cancelTimer();
    unsubscribe();
    stopEventHooks();
  };
}

/**
 * 把一条回路包成宿主级**唯一**的一份：首个取用方的 options 决定这一轮回路的接线，
 * 后来者只加引用计数，最后一个归还才真正停。返回的归还函数幂等。
 */
export function createPollingHandle<TOptions>(
  start: (options: TOptions) => () => void
): (options: TOptions) => () => void {
  let polling: { refs: number; stop: () => void } | null = null;
  return (options: TOptions) => {
    if (polling) polling.refs += 1;
    else polling = { refs: 1, stop: start(options) };

    let released = false;
    return () => {
      if (released || !polling) return;
      released = true;
      polling.refs -= 1;
      if (polling.refs > 0) return;
      polling.stop();
      polling = null;
    };
  };
}
