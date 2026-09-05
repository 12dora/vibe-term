/** 等待 `ms` 毫秒。不可中断，仅用于确定要睡满的场景。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 可中断的等待：睡满 `ms` 返回 `true`，中途被 `signal` 打断返回 `false`。
 *
 * 永远不 reject——调用方用布尔值决定「继续」还是「退出循环」，
 * 不必为「abort 当异常」再包一层 try/catch。定时器与监听器在任一分支都会清掉。
 */
export function sleepOrAbort(ms: number, signal?: AbortSignal | null): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (completed: boolean): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = (): void => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
