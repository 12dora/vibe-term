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
/** 上传写进度停滞：单次 write/end 超过此时长仍未返回即 RST，避免假 content-length / 死对端占满 cap。 */
export const UPLOAD_STALL_MS = 60_000;

export class UploadStallError extends Error {
  constructor() {
    super('upload-stall');
    this.name = 'UploadStallError';
  }
}

let httpHeadDeadlineOverride = 0;
let uploadStallOverride = 0;

/** 测试用：缩短 HTTP 响应头等待。`ms <= 0` 恢复自适应缺省。 */
export function setHttpHeadDeadlineMs(ms: number): void {
  httpHeadDeadlineOverride = ms > 0 ? ms : 0;
}

/** 测试用：缩短上传写停滞超时。`ms <= 0` 恢复 60 s 缺省。 */
export function setUploadStallMs(ms: number): void {
  uploadStallOverride = ms > 0 ? ms : 0;
}

export function uploadStallTimeoutMs(): number {
  return uploadStallOverride > 0 ? uploadStallOverride : UPLOAD_STALL_MS;
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

export function httpStreamTransferBudgetMs(opts: {
  floorMs: number;
  headers?: Record<string, string> | null;
  hasBody: boolean;
}): number {
  return (
    opts.floorMs +
    requestBodyUploadBudgetMs({
      contentLength: parseContentLengthHeader(opts.headers),
      hasRawBody: opts.hasBody,
    })
  );
}

export function authorizedAttemptBudgetsMs(input: {
  linkMs: number;
  overallMs: number;
  headers?: Record<string, string> | null;
  hasRawBody: boolean;
}): { linkMs: number; transferMs: number; overallMs: number } {
  const transferMs = httpStreamTransferBudgetMs({
    floorMs: input.linkMs,
    headers: input.headers,
    hasBody: input.hasRawBody,
  });
  return {
    linkMs: input.linkMs,
    transferMs,
    overallMs: input.overallMs + (transferMs - input.linkMs),
  };
}

/** 给 `openHttpStream` 套上传墙钟：有 body 按 content-length / 128 KiB/s（无 length 则 cap），下限为短转发档。 */
export async function withHttpStreamUploadDeadline<T>(
  parent: AbortSignal,
  floorMs: number,
  headers: Record<string, string> | null | undefined,
  hasBody: boolean,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const armed = armAttemptDeadline(
    parent,
    httpStreamTransferBudgetMs({ floorMs, headers, hasBody })
  );
  try {
    return await run(armed.signal);
  } finally {
    armed.dispose();
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

type UploadWriteDest = {
  write: (bytes: Uint8Array, opts?: { head?: boolean }) => Promise<void>;
  end: () => Promise<void>;
};

function raceWriteOrStall<T>(
  write: Promise<T>,
  opts: { stallMs: number; abort?: AbortSignal }
): Promise<T> {
  const abort = opts.abort;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => {
      done(() =>
        reject(abort?.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
      );
    };
    const timer = setTimeout(
      () => {
        done(() => {
          reject(
            abort?.aborted
              ? (abort.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
              : new UploadStallError()
          );
        });
      },
      Math.max(1, opts.stallMs)
    );
    write.then(
      (value) => done(() => resolve(value)),
      (err) => done(() => reject(err))
    );
    if (abort?.aborted) {
      onAbort();
      return;
    }
    abort?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 单次 write/end 在 stallMs 内未返回视为对端不读。调用方 abort 优先于 stall。 */
export function wrapUploadDestination(
  dst: UploadWriteDest,
  opts: { stallMs?: number; abort?: AbortSignal; onStall?: () => void }
): UploadWriteDest {
  const stallMs = opts.stallMs ?? uploadStallTimeoutMs();
  let stalled = false;
  const run = <T>(op: Promise<T>): Promise<T> =>
    raceWriteOrStall(op, { stallMs, abort: opts.abort }).catch((err: unknown) => {
      if (err instanceof UploadStallError && !stalled) {
        stalled = true;
        opts.onStall?.();
      }
      throw err;
    });
  return {
    write: (bytes, writeOpts) => run(dst.write(bytes, writeOpts)),
    end: () => run(dst.end()),
  };
}
