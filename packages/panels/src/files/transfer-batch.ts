// 批量传输的并发执行器：固定大小的文件级工作池 + 把每个条目的回调汇入同一份 `BatchProgress`。
// 不碰 UI；谁关心进度，谁订阅 `onChange` 再去读 `progress.view()`。

import type { OnLeg } from '@vibeterm/api-client';
import type { TransferPath } from './bulk-transfer';
import type { BatchProgress, LegWeights } from './transfer-progress';

/** 目标是本机（同机直传）时同时跑的文件数。 */
export const BATCH_CONCURRENCY_SELF = 3;
/** 经中继时同时跑的文件数：每个文件自己还有并行流，中继按流计配额，整体要压住。 */
export const BATCH_CONCURRENCY_RELAY = 2;

export function batchConcurrency(viaRelay: boolean): number {
  return viaRelay ? BATCH_CONCURRENCY_RELAY : BATCH_CONCURRENCY_SELF;
}

/**
 * 整批同时占用的并行流总预算（本机与中继共用）。HTTP/1.1 下浏览器对同一主机只放 6 个连接，
 * 预算要给列表 / 预览等普通请求留出余量，否则它们会排在 8 MiB 的 PUT 后面卡住界面。
 */
export const BATCH_STREAM_BUDGET = 4;

export interface StreamPlan {
  /** 整批的流总预算。 */
  budget: number;
  /** 单个文件的流数上限（即 `pickTransferStreams`）。 */
  perFileMax: number;
}

/** 预算按同时在跑的文件数均分，至少 1 条，最多不超过单文件上限。 */
export function streamsPerFile(plan: StreamPlan, peers: number): number {
  const share = Math.floor(plan.budget / Math.max(1, peers));
  return Math.min(plan.perFileMax, Math.max(1, share));
}

/** 交给单个条目传输函数的回调与取消信号（整批共用同一个信号）。 */
export interface BatchItemIo {
  signal: AbortSignal;
  /** 本文件可用的并行流数，由整批的流预算和同时在跑的文件数决定。 */
  streams: number;
  onLeg: OnLeg;
  onLegWeights: (weights: LegWeights) => void;
  onPath: (path: TransferPath) => void;
}

export interface ItemOutcome {
  status: 'done' | 'failed' | 'cancelled';
  error?: unknown;
}

export interface BatchRunOptions<T> {
  progress: BatchProgress;
  /** 与 `progress` 的条目下标一一对应。 */
  items: readonly T[];
  concurrency: number;
  streams: StreamPlan;
  signal: AbortSignal;
  run: (item: T, io: BatchItemIo) => Promise<unknown>;
  /** 进度或状态变了；`immediate` = 状态切换，订阅方不应节流。 */
  onChange?: (immediate: boolean) => void;
}

/** 批结束时展示给用户的结果，由调用方按条目结果组织文案。 */
export type BatchFinish =
  | { kind: 'success'; message: string }
  | { kind: 'failure'; message: string; description?: string }
  | { kind: 'cancel' };

function itemIo<T>(opts: BatchRunOptions<T>, index: number, streams: number): BatchItemIo {
  const { progress, onChange } = opts;
  return {
    signal: opts.signal,
    streams,
    onLeg: (leg, p) => {
      progress.leg(index, leg, p);
      onChange?.(p.pct >= 100);
    },
    onLegWeights: (weights) => {
      progress.weights(index, weights);
      onChange?.(false);
    },
    onPath: (path) => {
      progress.setPath(path);
      onChange?.(true);
    },
  };
}

interface BatchState {
  /** 已经结束（成功 / 失败 / 取消）的条目数，用来估计还会有几个文件同时在跑。 */
  finished: number;
}

async function runItem<T>(
  opts: BatchRunOptions<T>,
  state: BatchState,
  index: number
): Promise<ItemOutcome> {
  const { progress, onChange } = opts;
  // 与本文件同时在跑的文件数：不超过并发上限，也不超过还没结束的条目数。
  // 工作者在批开始时几乎同时领取条目，只数「已在跑」会让先领到的文件多拿流、总数超预算。
  const peers = Math.min(opts.concurrency, opts.items.length - state.finished);
  progress.setStatus(index, 'running');
  onChange?.(true);
  let outcome: ItemOutcome;
  try {
    const io = itemIo(opts, index, streamsPerFile(opts.streams, peers));
    await opts.run(opts.items[index] as T, io);
    outcome = { status: 'done' };
  } catch (error) {
    outcome = opts.signal.aborted ? { status: 'cancelled' } : { status: 'failed', error };
  }
  state.finished += 1;
  progress.setStatus(index, outcome.status);
  onChange?.(true);
  return outcome;
}

/**
 * 以 `concurrency` 个工作者逐个领取条目。单个条目失败不影响其余；
 * 取消会中止在途条目，没领到的条目直接记为已取消。
 */
export async function runTransferBatch<T>(opts: BatchRunOptions<T>): Promise<ItemOutcome[]> {
  const total = opts.items.length;
  const outcomes: ItemOutcome[] = new Array(total);
  const state: BatchState = { finished: 0 };
  let next = 0;
  const worker = async () => {
    while (!opts.signal.aborted && next < total) {
      const index = next++;
      outcomes[index] = await runItem(opts, state, index);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, opts.concurrency), total) }, worker);
  await Promise.all(workers);
  for (let index = 0; index < total; index++) {
    if (outcomes[index]) continue;
    outcomes[index] = { status: 'cancelled' };
    opts.progress.setStatus(index, 'cancelled');
  }
  opts.onChange?.(true);
  return outcomes;
}
