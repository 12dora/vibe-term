// 传输任务的宿主级 store：设备页的传输弹窗、文件面板的进度 Toast 共用同一份行。
//
// 两类行合在一起：
//  - `node`：跑在源节点上的节点间传输任务，由 `GET /api/transfer/jobs/:id/events`（NDJSON）驱动；
//  - `upload` / `download`：浏览器自己发起的两段式传输，由调用方按回调推进度。
//
// 不用 zustand：`@tmex/panels` 没有这个依赖（只有 `@tmex/stores` 有），而这里要的只是
// 「一份 Map + 订阅」，用 `useSyncExternalStore` 直接写反而少一层。

import type {
  TransferJobEvent,
  TransferJobSnapshot,
  TransferJobState,
  TransferPath,
  TransferProgress,
} from '@tmex/shared';
import { useCallback, useSyncExternalStore } from 'react';

/** 浏览器一侧在方向标里的占位 id（不是任何真实节点）。 */
export const BROWSER_ENDPOINT_ID = 'browser';

export type TransferEntryKind = 'node' | 'upload' | 'download';

/** 列表里的一行。节点任务与浏览器任务共用同一形状，`kind` 决定取消方式与方向文案。 */
export interface TransferJobView {
  key: string;
  kind: TransferEntryKind;
  /** 节点任务：任务所在的源节点；浏览器任务：另一端的节点。 */
  nodeId: string;
  jobId: string;
  fromNodeId: string;
  toNodeId: string;
  /** 当前条目的展示名（节点任务取 relPath，浏览器任务取文件名）。 */
  title: string;
  state: TransferJobState;
  progress: TransferProgress;
  /** 0–100。节点任务由字节算出，浏览器任务由两段进度合成。 */
  pct: number;
  path: TransferPath | null;
  itemsDone: number;
  itemsTotal: number;
  error?: string;
  errorDetail?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  cancellable: boolean;
}

const EMPTY_PROGRESS: TransferProgress = {
  transferredBytes: 0,
  totalBytes: 0,
  ratePerSec: 0,
  etaSec: null,
};

export function transferJobKey(nodeId: string, jobId: string): string {
  return `${nodeId}:${jobId}`;
}

export function isTerminalTransferState(state: TransferJobState): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled';
}

/** 字节进度 → 百分比。总量未知（0）时按 0 计。 */
export function transferPct(progress: TransferProgress): number {
  if (progress.totalBytes <= 0) return 0;
  const pct = (progress.transferredBytes / progress.totalBytes) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** 两段式传输合成一条进度：两段各占一半。 */
export function combineLegPct(leg1: number, leg2: number): number {
  const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0);
  return Math.round((clamp(leg1) + clamp(leg2)) / 2);
}

function currentTitle(job: TransferJobSnapshot): string {
  const item = job.currentIndex >= 0 ? job.items[job.currentIndex] : undefined;
  return item?.relPath ?? job.items[0]?.relPath ?? '';
}

function doneCount(job: TransferJobSnapshot): number {
  return job.items.filter((item) => item.state === 'done' || item.state === 'skipped').length;
}

export function viewFromSnapshot(nodeId: string, job: TransferJobSnapshot): TransferJobView {
  return {
    key: transferJobKey(nodeId, job.jobId),
    kind: 'node',
    nodeId,
    jobId: job.jobId,
    fromNodeId: job.fromNodeId,
    toNodeId: job.toNodeId,
    title: currentTitle(job),
    state: job.state,
    progress: job.progress,
    pct: transferPct(job.progress),
    path: job.path,
    itemsDone: doneCount(job),
    itemsTotal: job.items.length,
    error: job.error,
    errorDetail: job.errorDetail,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    cancellable: !isTerminalTransferState(job.state),
  };
}

/** NDJSON 事件落到一行上。未知事件与不匹配的 jobId 原样返回，调用方据此判断是否需要通知。 */
export function reduceTransferEvent(
  view: TransferJobView,
  nodeId: string,
  event: TransferJobEvent
): TransferJobView {
  switch (event.type) {
    case 'snapshot':
      return viewFromSnapshot(nodeId, event.job);
    case 'progress':
      return {
        ...view,
        progress: event.progress,
        pct: transferPct(event.progress),
        updatedAt: event.updatedAt,
      };
    case 'item': {
      const wasDone = view.title === event.item.relPath;
      const finished = event.item.state === 'done' || event.item.state === 'skipped';
      return {
        ...view,
        title: finished && wasDone ? view.title : event.item.relPath,
        itemsDone: finished ? Math.max(view.itemsDone, event.index + 1) : view.itemsDone,
        itemsTotal: Math.max(view.itemsTotal, event.index + 1),
      };
    }
    case 'state': {
      const terminal = isTerminalTransferState(event.state);
      return {
        ...view,
        state: event.state,
        error: event.error ?? view.error,
        errorDetail: event.errorDetail ?? view.errorDetail,
        cancellable: !terminal,
        finishedAt: terminal ? (view.finishedAt ?? Date.now()) : view.finishedAt,
      };
    }
    case 'end':
      return view;
  }
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

const entries = new Map<string, TransferJobView>();
const cancels = new Map<string, () => void>();
const listeners = new Set<() => void>();
let snapshot: readonly TransferJobView[] = [];

function publish(): void {
  snapshot = [...entries.values()].sort((a, b) => b.createdAt - a.createdAt);
  for (const listener of listeners) listener();
}

export function subscribeTransferJobsStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTransferJobsSnapshot(): readonly TransferJobView[] {
  return snapshot;
}

export function getTransferJobView(key: string): TransferJobView | undefined {
  return entries.get(key);
}

/** 传输列表；引用只在内容真的变了时才换，未变化的消费方不重渲染。 */
export function useTransferJobs(): readonly TransferJobView[] {
  return useSyncExternalStore(
    useCallback((listener: () => void) => subscribeTransferJobsStore(listener), []),
    getTransferJobsSnapshot,
    getTransferJobsSnapshot
  );
}

export function putTransferJobView(view: TransferJobView): void {
  entries.set(view.key, view);
  publish();
}

/** 快照合并：已有行只更新，避免打断本地正在跑的取消回调登记。 */
export function upsertTransferJobSnapshot(nodeId: string, job: TransferJobSnapshot): void {
  putTransferJobView(viewFromSnapshot(nodeId, job));
}

export function applyTransferJobEvent(
  nodeId: string,
  jobId: string,
  event: TransferJobEvent
): void {
  const key = transferJobKey(nodeId, jobId);
  const view = entries.get(key);
  if (!view) {
    if (event.type !== 'snapshot') return;
    upsertTransferJobSnapshot(nodeId, event.job);
    return;
  }
  const next = reduceTransferEvent(view, nodeId, event);
  if (next === view) return;
  entries.set(key, next);
  publish();
}

export function removeTransferJob(key: string): void {
  cancels.delete(key);
  if (!entries.delete(key)) return;
  publish();
}

/** 清掉所有已结束的行（完成 / 失败 / 已取消）。 */
export function clearFinishedTransferJobs(): void {
  let changed = false;
  for (const [key, view] of entries) {
    if (!isTerminalTransferState(view.state)) continue;
    entries.delete(key);
    cancels.delete(key);
    changed = true;
  }
  if (changed) publish();
}

export function registerTransferCancel(key: string, cancel: () => void): void {
  cancels.set(key, cancel);
}

export function cancelTransferJobEntry(key: string): void {
  cancels.get(key)?.();
}

export function resetTransferJobsForTest(): void {
  entries.clear();
  cancels.clear();
  publish();
}

// ---------------------------------------------------------------------------
// 浏览器侧任务（上传 / 下载）
// ---------------------------------------------------------------------------

/** 采样点滑窗算速率：窗口内的字节差 / 时间差，避免整段平均把瞬时速率抹平。 */
export interface RateEstimator {
  sample(transferredBytes: number, totalBytes: number, now: number): TransferProgress;
}

const RATE_WINDOW_MS = 3000;

export function createRateEstimator(): RateEstimator {
  const samples: Array<{ at: number; bytes: number }> = [];
  return {
    sample(transferredBytes, totalBytes, now) {
      samples.push({ at: now, bytes: transferredBytes });
      while (samples.length > 2 && now - samples[0].at > RATE_WINDOW_MS) samples.shift();
      const first = samples[0];
      const seconds = (now - first.at) / 1000;
      const ratePerSec = seconds > 0 ? Math.max(0, (transferredBytes - first.bytes) / seconds) : 0;
      const remaining = totalBytes > 0 ? Math.max(0, totalBytes - transferredBytes) : 0;
      const etaSec = ratePerSec > 0 && totalBytes > 0 ? remaining / ratePerSec : null;
      return { transferredBytes, totalBytes, ratePerSec, etaSec };
    },
  };
}

export interface LocalTransferOptions {
  /** 行的唯一 id（同一文件可能同时传多次，调用方自带序号）。 */
  id: string;
  kind: 'upload' | 'download';
  title: string;
  /** 另一端的节点（`self` 或 32 位 hex）。 */
  nodeId: string;
  /** 已知总字节数；未知时列表只显示百分比。 */
  totalBytes?: number;
  onCancel?: () => void;
}

export interface LocalTransferHandle {
  key: string;
  setPct(pct: number): void;
  setPath(path: TransferPath): void;
  done(): void;
  fail(error?: string): void;
  cancelled(): void;
}

/** 登记一条浏览器任务；返回的句柄由 `startTransferToast` 与 bulk 传输推进。 */
export function startLocalTransfer(options: LocalTransferOptions): LocalTransferHandle {
  const key = `local:${options.kind}:${options.id}`;
  const total = options.totalBytes ?? 0;
  const upload = options.kind === 'upload';
  const now = Date.now();
  const estimator = createRateEstimator();

  putTransferJobView({
    key,
    kind: options.kind,
    nodeId: options.nodeId,
    jobId: options.id,
    fromNodeId: upload ? BROWSER_ENDPOINT_ID : options.nodeId,
    toNodeId: upload ? options.nodeId : BROWSER_ENDPOINT_ID,
    title: options.title,
    state: 'running',
    progress: { ...EMPTY_PROGRESS, totalBytes: total },
    pct: 0,
    path: null,
    itemsDone: 0,
    itemsTotal: 1,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    cancellable: Boolean(options.onCancel),
  });
  if (options.onCancel) registerTransferCancel(key, options.onCancel);

  const patch = (next: Partial<TransferJobView>) => {
    const view = entries.get(key);
    if (!view) return;
    entries.set(key, { ...view, ...next, updatedAt: Date.now() });
    publish();
  };

  const settle = (state: TransferJobState, error?: string) =>
    patch({ state, error, cancellable: false, finishedAt: Date.now() });

  return {
    key,
    setPct(pct) {
      const clamped = Math.max(0, Math.min(100, Math.round(pct)));
      const transferred = total > 0 ? Math.round((total * clamped) / 100) : 0;
      patch({ pct: clamped, progress: estimator.sample(transferred, total, Date.now()) });
    },
    setPath(path) {
      patch({ path });
    },
    done() {
      patch({ pct: 100 });
      settle('done');
    },
    fail(error) {
      settle('failed', error);
    },
    cancelled() {
      settle('cancelled');
    },
  };
}
