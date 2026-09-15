import { WS_RACE_OPEN_TIMEOUT_MS } from './ws-open-race';

/** fake-IP 第一次 TCP 的上限；与 `min(3000, floor(timeoutMs / 3))` 合用。 */
export const FAKE_FIRST_CONNECT_MAX_MS = 3_000;

export function fakeFirstConnectBudgetMs(timeoutMs?: number): number {
  const full = timeoutMs != null && timeoutMs > 0 ? timeoutMs : WS_RACE_OPEN_TIMEOUT_MS;
  return Math.min(FAKE_FIRST_CONNECT_MAX_MS, Math.floor(full / 3));
}

export function remainingConnectBudgetMs(
  fullMs: number,
  startedAt: number,
  nowMs = Date.now()
): number {
  return Math.max(0, fullMs - (nowMs - startedAt));
}

export function childConnectBudget(
  parent: AbortSignal | undefined,
  budgetMs: number
): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(
    () => {
      if (!ac.signal.aborted) ac.abort(new Error('connect-timeout'));
    },
    Math.max(0, budgetMs)
  );
  const onParent = (): void => {
    if (!ac.signal.aborted) ac.abort(parent?.reason);
  };
  if (parent?.aborted) onParent();
  else parent?.addEventListener('abort', onParent, { once: true });
  return {
    signal: ac.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParent);
    },
  };
}

export async function withConnectBudget<T>(
  parent: AbortSignal | undefined,
  budgetMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const child = childConnectBudget(parent, budgetMs);
  try {
    return await run(child.signal);
  } finally {
    child.dispose();
  }
}

/** 假 IP 先短预算拨号；失败再用剩余预算重拨。父 signal 已 abort 则不重拨。 */
export async function runFakeThenRedial<T>(opts: {
  parent?: AbortSignal;
  timeoutMs?: number;
  first: (signal: AbortSignal, timeoutMs: number) => Promise<T>;
  redial: (err: unknown, signal: AbortSignal, timeoutMs: number) => Promise<T>;
}): Promise<T> {
  const fullMs =
    opts.timeoutMs != null && opts.timeoutMs > 0 ? opts.timeoutMs : WS_RACE_OPEN_TIMEOUT_MS;
  const shortMs = fakeFirstConnectBudgetMs(fullMs);
  const started = Date.now();
  try {
    return await withConnectBudget(opts.parent, shortMs, (signal) => opts.first(signal, shortMs));
  } catch (err) {
    if (opts.parent?.aborted) throw err;
    const remain = remainingConnectBudgetMs(fullMs, started);
    return await withConnectBudget(opts.parent, remain, (signal) =>
      opts.redial(err, signal, remain)
    );
  }
}
