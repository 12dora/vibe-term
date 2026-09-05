/**
 * 合并多个 AbortSignal：任意一个 abort，返回的 signal 就 abort（原样带上那个 signal 的 reason）。
 *
 * 有原生 `AbortSignal.any` 就走它；否则手搭一个 `AbortController`，谁先触发就转发谁的 reason，
 * 之后把所有输入信号上挂的监听器都摘掉，避免长命 signal（如从不 abort 的用户信号）攒监听器泄漏。
 */
export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined | null>
): AbortSignal | undefined {
  const usable = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (usable.length === 0) return undefined;
  if (usable.length === 1) return usable[0];

  if (typeof AbortSignal.any === 'function') return AbortSignal.any(usable);

  const controller = new AbortController();
  const already = usable.find((signal) => signal.aborted);
  if (already) {
    controller.abort(already.reason);
    return controller.signal;
  }

  const removers: Array<() => void> = [];
  const cleanup = (): void => {
    for (const remove of removers) remove();
    removers.length = 0;
  };
  for (const signal of usable) {
    const onAbort = (): void => {
      controller.abort(signal.reason);
      cleanup();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    removers.push(() => signal.removeEventListener('abort', onAbort));
  }
  return controller.signal;
}
