import { nestedDialBudgetsMs } from '@vibeterm/shared/net';

/** 消息用 `timeout`：`classifyUnreachableReason` 据此把 503 的 reason 判成 timeout。 */
export class ForwardDeadlineError extends Error {
  constructor() {
    super('timeout');
    this.name = 'ForwardDeadlineError';
  }
}

/** 估算上传耗时的保守吞吐下限；低于此值的链路仍靠「写完再 arm head」兜住。 */
export const UPLOAD_MIN_THROUGHPUT_BPS = 128 * 1024;
/** 单次上传额外预算上限（10 min），与远程升级 push 墙钟同量级。 */
export const UPLOAD_BUDGET_CAP_MS = 10 * 60 * 1000;

let httpHeadDeadlineOverride = 0;

/** 测试用：缩短 HTTP 响应头等待。`ms <= 0` 恢复自适应缺省。 */
export function setHttpHeadDeadlineMs(ms: number): void {
  httpHeadDeadlineOverride = ms > 0 ? ms : 0;
}

/** 无请求体时的 head 等待：与转发取链同一档 `forwardMs`（5–20 s）。 */
export function httpHeadTimeoutMs(rttMs?: number | null): number {
  if (httpHeadDeadlineOverride > 0) return httpHeadDeadlineOverride;
  return nestedDialBudgetsMs(rttMs).forwardMs;
}

export function parseContentLengthHeader(headers?: Record<string, string> | null): number | null {
  if (!headers) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'content-length') continue;
    const n = Number(value.trim());
    if (!Number.isInteger(n) || n < 0) return null;
    return n;
  }
  return null;
}

export function uploadBudgetMs(
  bodyBytes: number,
  minThroughputBps = UPLOAD_MIN_THROUGHPUT_BPS
): number {
  if (!Number.isFinite(bodyBytes) || bodyBytes <= 0) return 0;
  const bps = Number.isFinite(minThroughputBps) && minThroughputBps > 0 ? minThroughputBps : 1;
  return Math.min(UPLOAD_BUDGET_CAP_MS, Math.ceil((bodyBytes / bps) * 1000));
}

export function requestBodyUploadBudgetMs(opts: {
  contentLength?: number | null;
  hasRawBody?: boolean;
}): number {
  const length = opts.contentLength;
  if (typeof length === 'number' && Number.isFinite(length) && length > 0) {
    return uploadBudgetMs(length);
  }
  return opts.hasRawBody ? UPLOAD_BUDGET_CAP_MS : 0;
}

export function authorizedAttemptBudgetsMs(input: {
  linkMs: number;
  overallMs: number;
  headers?: Record<string, string> | null;
  hasRawBody: boolean;
}): { linkMs: number; transferMs: number; overallMs: number } {
  const uploadMs = requestBodyUploadBudgetMs({
    contentLength: parseContentLengthHeader(input.headers),
    hasRawBody: input.hasRawBody,
  });
  return {
    linkMs: input.linkMs,
    transferMs: input.linkMs + uploadMs,
    overallMs: input.overallMs + uploadMs,
  };
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

/**
 * 可推迟启动的一次性超时：`armAfter` 兑现后才开始计时（请求体还在写时不跑 head 钟）。
 * 调用方 abort 会 dispose，不触发 onTimeout。
 */
export function armDeferredTimeout(opts: {
  timeoutMs: number;
  armAfter?: Promise<unknown>;
  abort?: AbortSignal;
  onTimeout: () => void;
}): { dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const onAbort = (): void => dispose();
  const dispose = (): void => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    opts.abort?.removeEventListener('abort', onAbort);
  };
  const startTimer = (): void => {
    if (disposed || timer !== undefined) return;
    timer = setTimeout(
      () => {
        if (disposed) return;
        disposed = true;
        opts.onTimeout();
      },
      Math.max(0, opts.timeoutMs)
    );
  };
  if (opts.abort?.aborted) return { dispose };
  opts.abort?.addEventListener('abort', onAbort, { once: true });
  if (!opts.armAfter) startTimer();
  else void opts.armAfter.then(startTimer, () => undefined);
  return { dispose };
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

/** 取链用短预算；拿到 link 后再用含上传余量的预算跑传输，调用方 abort 全程可打断。 */
export async function runLinkThenTransfer<L, R>(opts: {
  parent: AbortSignal;
  linkBudgetMs: number;
  transferBudgetMs: number;
  getLink: Promise<L>;
  transfer: (link: L, signal: AbortSignal) => Promise<R>;
}): Promise<R> {
  const linkArmed = armAttemptDeadline(opts.parent, opts.linkBudgetMs);
  try {
    const link = await waitLinkOrAbort(opts.getLink, linkArmed.signal);
    linkArmed.dispose();
    const transferArmed = armAttemptDeadline(opts.parent, opts.transferBudgetMs);
    try {
      return await opts.transfer(link, transferArmed.signal);
    } finally {
      transferArmed.dispose();
    }
  } finally {
    linkArmed.dispose();
  }
}
