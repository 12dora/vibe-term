/** 消息用 `timeout`：`classifyUnreachableReason` 据此把 503 的 reason 判成 timeout。 */
export class ForwardDeadlineError extends Error {
  constructor() {
    super('timeout');
    this.name = 'ForwardDeadlineError';
  }
}

/** 单次转发尝试：到点 abort，并转发调用方的 abort；settled 后必须 dispose 清 timer。 */
export function armAttemptDeadline(
  parent: AbortSignal,
  budgetMs: number
): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController();
  const reason = () => new ForwardDeadlineError();
  const abortCtrl = (value?: unknown): void => {
    if (!ctrl.signal.aborted) ctrl.abort(value ?? reason());
  };
  const timer = setTimeout(() => abortCtrl(), Math.max(0, budgetMs));
  const onParent = (): void => abortCtrl(parent.reason ?? reason());
  if (parent.aborted) onParent();
  else parent.addEventListener('abort', onParent, { once: true });
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onParent);
    },
  };
}

/** `getLink()` 不接 signal：用 abort 竞速，超时抛 ForwardDeadlineError。 */
export async function waitLinkOrAbort<T>(pending: Promise<T>, abort: AbortSignal): Promise<T> {
  if (abort.aborted) throw new ForwardDeadlineError();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    abort.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const won = await Promise.race([pending, aborted]);
    if (won != null) return won;
    void pending.catch(() => undefined);
    throw new ForwardDeadlineError();
  } finally {
    if (onAbort) abort.removeEventListener('abort', onAbort);
  }
}
