// 推送驱动：偏移协商 → 把缺口切成 N 个不相交区间并行推 → 失败分类 → 退避 → 续传。
// 从 `apps/gateway/src/system/remote-upgrade-job.ts` 的推包循环抽出，`streams: 1` 时行为与它一致。
// 本文件不碰文件系统，浏览器上传与节点间传输共用同一份。

import { chopRanges, complementRanges, coveredBytes, splitRanges } from './ranges';
import type { ByteRange, ReceivedState } from './types';

/** 退避阶梯（毫秒），封顶 15 s。 */
export const PUSH_RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 15000, 15000] as const;
export const PUSH_MAX_ATTEMPTS = 8;

/** 一次区间推送的结论。`retry` 判定为链路问题，可以退避后接着补发。 */
export type PushOutcome =
  | { kind: 'landed' }
  | { kind: 'retry'; error: string }
  | { kind: 'fail'; error: string }
  | { kind: 'cancelled' };

export interface PushPutOptions {
  /**
   * 本轮尝试的信号：调用方取消、剩余期限用尽、或本轮已经出结论时都会 abort。
   * 传输层必须把它接到请求与响应体的消费上，否则卡住的响应能拖过整个截止时间。
   */
  signal: AbortSignal;
  /** 本区间已上行的字节数（相对区间起点）。 */
  onProgress: (uploadedInRange: number) => void;
  /** 本轮尝试的绝对截止时间戳。 */
  deadlineMs: number;
}

export interface PushTransport {
  /** 问对端已收多少；查不到返回 null，驱动按 0 处理（最坏多花一次带宽）。 */
  status(signal: AbortSignal): Promise<ReceivedState | null>;
  put(range: ByteRange, opts: PushPutOptions): Promise<PushOutcome>;
}

export interface RunPushOptions {
  totalBytes: number;
  /** 并行流数；1 时与旧的顺序续传语义完全一致。 */
  streams?: number;
  /** 单次 put 的体积上限：切得越细，进度越平滑、一次中断丢掉的字节越少。 */
  maxRangeBytes?: number;
  maxAttempts?: number;
  backoffMs?: readonly number[];
  /** 整个推送阶段的绝对截止时间戳。 */
  deadlineMs: number;
  /** 关掉后每轮都从 0 重推（对端不支持续传）。 */
  resume?: boolean;
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 累计已确认字节（含本轮之前已在对端的部分）。 */
  onProgress?: (transferredBytes: number) => void;
  onAttempt?: (attempt: number) => void;
  /** 超时/未开始时的兜底错误文案。 */
  timeoutError?: string;
  /** 盘上半成品与摘要对不上之类的确定性失败：允许整包重推一次。 */
  shouldRestartFromZero?: (error: string, offset: number) => boolean;
}

export type RunPushResult =
  | { kind: 'done'; transferredBytes: number }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string };

export function backoffAt(attempt: number, ladder: readonly number[]): number {
  return ladder[attempt - 1] ?? ladder[ladder.length - 1] ?? 15000;
}

function receivedRanges(state: ReceivedState | null, total: number): ByteRange[] {
  if (!state) return [];
  if (state.ranges.length > 0) return state.ranges;
  const received = Math.max(0, Math.min(state.receivedBytes, total));
  return received > 0 ? [{ offset: 0, length: received }] : [];
}

const OUTCOME_RANK: Record<PushOutcome['kind'], number> = {
  landed: 0,
  retry: 1,
  fail: 2,
  cancelled: 3,
};

/**
 * 本轮尝试的信号：调用方取消、剩余期限用尽都会 abort，本轮出结论后也主动 abort，
 * 把还挂着的并行请求一起收掉——否则一条卡死的响应能把整个工作池吊在那里。
 */
type AttemptScope = { signal: AbortSignal; abort: () => void; dispose: () => void };

function attemptScope(opts: RunPushOptions): AttemptScope {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  const remaining = opts.deadlineMs - (opts.now ?? Date.now)();
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (opts.signal.aborted || !(remaining > 0)) controller.abort();
  else {
    opts.signal.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(remaining)) {
      timer = setTimeout(onAbort, remaining);
      (timer as unknown as { unref?: () => void }).unref?.();
    }
  }
  return {
    signal: controller.signal,
    abort: onAbort,
    dispose: () => {
      if (timer) clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 本轮尝试被我们自己收掉（期限到 / 已出结论）时传输层报的 `cancelled` 不是用户取消，
 * 降级成可重试的链路错误，免得盖掉真正的失败原因。
 */
function normalizeOutcome(
  outcome: PushOutcome,
  opts: RunPushOptions,
  scope: AttemptScope
): PushOutcome {
  if (outcome.kind !== 'cancelled') return outcome;
  if (opts.signal.aborted || !scope.signal.aborted) return outcome;
  return { kind: 'retry', error: 'push attempt aborted' };
}

/** 并发上限为 `limit` 的工作池：区间按序发放，任一段出问题就不再发新的。 */
async function runAttempt(
  transport: PushTransport,
  ranges: readonly ByteRange[],
  opts: RunPushOptions,
  base: number,
  scope: AttemptScope
): Promise<PushOutcome> {
  const uploaded = new Map<number, number>();
  let worst: PushOutcome = { kind: 'landed' };
  let cursor = 0;
  const report = (): void => {
    let sum = base;
    for (const value of uploaded.values()) sum += value;
    opts.onProgress?.(Math.min(sum, opts.totalBytes));
  };
  const worker = async (): Promise<void> => {
    for (;;) {
      if (worst.kind !== 'landed' || opts.signal.aborted || scope.signal.aborted) return;
      const range = ranges[cursor];
      cursor += 1;
      if (range === undefined) return;
      const outcome = normalizeOutcome(
        await transport.put(range, {
          signal: scope.signal,
          deadlineMs: opts.deadlineMs,
          onProgress: (n) => {
            uploaded.set(range.offset, Math.max(0, Math.min(n, range.length)));
            report();
          },
        }),
        opts,
        scope
      );
      if (outcome.kind === 'landed') uploaded.set(range.offset, range.length);
      report();
      if (OUTCOME_RANK[outcome.kind] > OUTCOME_RANK[worst.kind]) worst = outcome;
      // 本轮已经出结论：把还在飞的请求一起中止，不必等它们各自超时。
      if (worst.kind !== 'landed') scope.abort();
    }
  };
  const lanes = Math.max(1, Math.min(opts.streams ?? 1, ranges.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  // 取消永远压过其它结论：哪怕有几段已经落地，整次推送也算取消。
  if (opts.signal.aborted) return { kind: 'cancelled' };
  return worst;
}

type PushPlan = { complete: boolean; ranges: ByteRange[]; base: number };

async function negotiate(
  transport: PushTransport,
  opts: RunPushOptions,
  fromZero: boolean,
  scope: AttemptScope
): Promise<PushPlan> {
  const state = fromZero || opts.resume === false ? null : await transport.status(scope.signal);
  if (state?.complete) return { complete: true, ranges: [], base: opts.totalBytes };
  const known = receivedRanges(state, opts.totalBytes);
  const base = Math.min(coveredBytes(known), opts.totalBytes);
  opts.onProgress?.(base);
  if (opts.totalBytes === 0)
    return { complete: false, ranges: [{ offset: 0, length: 0 }], base: 0 };
  const missing = complementRanges(opts.totalBytes, known);
  // 缺口为空但对端没说 complete：补一次零长度推送，让它校验摘要并落位。
  if (missing.length === 0) {
    return { complete: false, ranges: [{ offset: opts.totalBytes, length: 0 }], base };
  }
  // 定了单次上限就按上限切齐（分片上传的常规做法），并发度交给工作池；
  // 没定上限才按流数等分，让每条流一口气推完自己那一段（升级推包就是这种）。
  const planned = opts.maxRangeBytes
    ? chopRanges(missing, opts.maxRangeBytes)
    : splitRanges(missing, Math.max(1, opts.streams ?? 1));
  return { complete: false, ranges: planned, base };
}

type AttemptDecision =
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string }
  | { kind: 'continue'; error: string; fromZero: boolean };

function decide(
  outcome: PushOutcome,
  plan: PushPlan,
  opts: RunPushOptions,
  fromZero: boolean
): AttemptDecision {
  if (outcome.kind === 'landed') return { kind: 'done' };
  if (outcome.kind === 'cancelled') return { kind: 'cancelled' };
  if (outcome.kind === 'fail') {
    const canRestart = !fromZero && opts.shouldRestartFromZero?.(outcome.error, plan.base) === true;
    if (!canRestart) return { kind: 'failed', error: outcome.error };
    return { kind: 'continue', error: outcome.error, fromZero: true };
  }
  return { kind: 'continue', error: outcome.error, fromZero };
}

export async function runPush(
  transport: PushTransport,
  opts: RunPushOptions
): Promise<RunPushResult> {
  const now = opts.now ?? Date.now;
  const maxAttempts = opts.maxAttempts ?? PUSH_MAX_ATTEMPTS;
  const ladder = opts.backoffMs ?? PUSH_RETRY_BACKOFF_MS;
  const timeoutError = opts.timeoutError ?? 'push timeout';
  let lastError = timeoutError;
  let fromZero = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (opts.signal.aborted) return { kind: 'cancelled' };
    opts.onAttempt?.(attempt);
    const decision = await runAttemptOnce(transport, opts, fromZero, timeoutError);
    if (decision.kind === 'done') return { kind: 'done', transferredBytes: opts.totalBytes };
    if (decision.kind === 'cancelled') return { kind: 'cancelled' };
    if (decision.kind === 'failed') return { kind: 'failed', error: decision.error };
    fromZero = decision.fromZero;
    lastError = decision.error;
    if (now() >= opts.deadlineMs) return { kind: 'failed', error: timeoutError };
    if (attempt >= maxAttempts) break;
    if (!(await backoff(opts, attempt, ladder))) return { kind: 'cancelled' };
    if (now() >= opts.deadlineMs) return { kind: 'failed', error: timeoutError };
  }
  return { kind: 'failed', error: lastError };
}

/** 一轮：协商缺口 → 并行推送 → 归类。整轮共用一个带期限的中止信号。 */
async function runAttemptOnce(
  transport: PushTransport,
  opts: RunPushOptions,
  fromZero: boolean,
  timeoutError: string
): Promise<AttemptDecision> {
  const now = opts.now ?? Date.now;
  const scope = attemptScope(opts);
  try {
    const plan = await negotiate(transport, opts, fromZero, scope);
    if (opts.signal.aborted) return { kind: 'cancelled' };
    if (plan.complete) return { kind: 'done' };
    if (now() >= opts.deadlineMs) return { kind: 'failed', error: timeoutError };
    return decide(
      await runAttempt(transport, plan.ranges, opts, plan.base, scope),
      plan,
      opts,
      fromZero
    );
  } finally {
    scope.abort();
    scope.dispose();
  }
}

async function backoff(
  opts: RunPushOptions,
  attempt: number,
  ladder: readonly number[]
): Promise<boolean> {
  const sleep = opts.sleep;
  if (!sleep) return !opts.signal.aborted;
  try {
    await sleep(backoffAt(attempt, ladder), opts.signal);
  } catch {
    return false;
  }
  return !opts.signal.aborted;
}
