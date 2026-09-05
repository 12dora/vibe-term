// 冷启动阶段那两条必打的入口请求（`/api/auth/mode`、`/api/mesh/nodes`）的失败恢复。
//
// 它们此前都是「失败即永久记住」：`ensureAuthMode` 的 promise 只在 reset 时清、
// `refreshMeshNodes` 的错误要等 5 分钟兜底轮询才有下一次。移动端切回前台的第一秒射频还没
// 起来，这两条请求几乎必然失败一次——于是整个侧边栏空到下一拍。
//
// 这里给一条**有界**的重试阶梯（1 / 3 / 10 秒，共三次），外加「页面重新可见 / 网络恢复」
// 时的立即重试。有界是关键：无限重试在真的断网时就变成了新的定时器。

/** 有界重试阶梯（毫秒）。 */
export const RECOVERY_RETRY_MS = [1_000, 3_000, 10_000] as const;

export interface RetryScheduler {
  /** 排下一次重试；阶梯用尽后什么都不做（返回 false）。 */
  schedule(run: () => void): boolean;
  /** 恢复信号到达：清掉在途定时器并把阶梯倒回起点。 */
  reset(): void;
  /** 已经排掉的次数（测试用）。 */
  readonly attempt: number;
}

export interface RetrySchedulerOptions {
  delays?: readonly number[];
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export function createRetryScheduler(options: RetrySchedulerOptions = {}): RetryScheduler {
  const delays = options.delays ?? RECOVERY_RETRY_MS;
  const setTimeoutFn =
    options.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as never));
  let attempt = 0;
  let timer: unknown = null;

  return {
    get attempt() {
      return attempt;
    },
    schedule(run) {
      if (timer !== null) return true;
      const delay = delays[attempt];
      if (delay === undefined) return false;
      attempt += 1;
      timer = setTimeoutFn(() => {
        timer = null;
        run();
      }, delay);
      return true;
    },
    reset() {
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
      attempt = 0;
    },
  };
}

export type RecoverySubscribe = (listener: () => void) => () => void;

const NOOP_UNSUBSCRIBE = () => undefined;

/**
 * 「页面重新可见」与「网络恢复」这两个信号。测试 / SSR 环境没有 document 时返回空订阅，
 * 调用方不必各自判环境。
 */
export function onPageRecovery(listener: () => void): () => void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc || typeof doc.addEventListener !== 'function') return NOOP_UNSUBSCRIBE;
  const onVisible = () => {
    if (doc.visibilityState !== 'hidden') listener();
  };
  doc.addEventListener('visibilitychange', onVisible);
  const target = (globalThis as { addEventListener?: typeof addEventListener }).addEventListener
    ? globalThis
    : null;
  target?.addEventListener('online', listener);
  return () => {
    doc.removeEventListener('visibilitychange', onVisible);
    target?.removeEventListener('online', listener);
  };
}

/** 页面此刻是否可见（取不到 document 一律按可见处理）。 */
export function isPageVisible(): boolean {
  const doc = (globalThis as { document?: Document }).document;
  return !doc || doc.visibilityState !== 'hidden';
}
