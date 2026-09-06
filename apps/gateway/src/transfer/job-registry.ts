// 源节点 A 上的任务登记表。与远程升级作业一样只放内存：真正的断点续传状态在目标节点的
// `.part` 上，进程重启后重新发起同一次传输会自动接着传。完成的任务留 30 分钟供前端回看。

import type {
  TransferErrorCode,
  TransferItemState,
  TransferJobEvent,
  TransferJobItem,
  TransferJobSnapshot,
  TransferJobState,
  TransferPath,
} from '@tmex/shared';
import { ProgressTracker, throttleProgress } from '@tmex/transfer';

const FINISHED_TTL_MS = 30 * 60_000;
const PROGRESS_INTERVAL_MS = 200;

type Listener = (event: TransferJobEvent) => void;

export interface TransferJobRecord {
  snapshot: TransferJobSnapshot;
  uid: string;
  abort: AbortController;
  listeners: Set<Listener>;
  tracker: ProgressTracker;
  emitProgress: (bytes: number) => void;
}

const jobs = new Map<string, TransferJobRecord>();

function sweep(now: number): void {
  for (const [id, job] of jobs) {
    const finishedAt = job.snapshot.finishedAt;
    if (finishedAt !== null && now - finishedAt > FINISHED_TTL_MS) jobs.delete(id);
  }
}

function emit(job: TransferJobRecord, event: TransferJobEvent): void {
  job.snapshot.updatedAt = Date.now();
  for (const listener of [...job.listeners]) {
    try {
      listener(event);
    } catch {
      // 单个订阅者出错不影响其他订阅者
    }
  }
}

export function createJob(input: {
  jobId: string;
  uid: string;
  fromNodeId: string;
  toNodeId: string;
  destRootId: string;
  destPath: string;
  path: TransferPath;
  streams: number;
  now?: number;
}): TransferJobRecord {
  const now = input.now ?? Date.now();
  sweep(now);
  const snapshot: TransferJobSnapshot = {
    jobId: input.jobId,
    state: 'queued',
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    destRootId: input.destRootId,
    destPath: input.destPath,
    expanding: true,
    items: [],
    currentIndex: -1,
    progress: { transferredBytes: 0, totalBytes: 0, ratePerSec: 0, etaSec: null },
    streams: input.streams,
    path: input.path,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  };
  const tracker = new ProgressTracker({ totalBytes: 0 });
  const job: TransferJobRecord = {
    snapshot,
    uid: input.uid,
    abort: new AbortController(),
    listeners: new Set(),
    tracker,
    emitProgress: () => {},
  };
  job.emitProgress = throttleProgress(
    (bytes) => {
      tracker.set(bytes);
      snapshot.progress = tracker.snapshot();
      emit(job, {
        type: 'progress',
        jobId: snapshot.jobId,
        currentIndex: snapshot.currentIndex,
        progress: snapshot.progress,
        updatedAt: Date.now(),
      });
    },
    { intervalMs: PROGRESS_INTERVAL_MS }
  );
  jobs.set(input.jobId, job);
  return job;
}

export function getJob(jobId: string): TransferJobRecord | undefined {
  sweep(Date.now());
  return jobs.get(jobId);
}

export function listJobs(uid: string): TransferJobSnapshot[] {
  sweep(Date.now());
  return [...jobs.values()]
    .filter((job) => job.uid === uid)
    .map((job) => job.snapshot)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function subscribeJob(job: TransferJobRecord, listener: Listener): () => void {
  job.listeners.add(listener);
  return () => {
    job.listeners.delete(listener);
  };
}

export function setJobItems(job: TransferJobRecord, items: TransferJobItem[]): void {
  job.snapshot.items = items;
  job.snapshot.progress.totalBytes = items.reduce((sum, item) => sum + item.size, 0);
  job.tracker.totalBytes = job.snapshot.progress.totalBytes;
  emit(job, { type: 'snapshot', job: job.snapshot });
}

export function setJobExpanding(job: TransferJobRecord, expanding: boolean): void {
  job.snapshot.expanding = expanding;
  emit(job, { type: 'snapshot', job: job.snapshot });
}

export function setJobState(
  job: TransferJobRecord,
  state: TransferJobState,
  error?: TransferErrorCode,
  errorDetail?: string
): void {
  job.snapshot.state = state;
  if (error) job.snapshot.error = error;
  if (errorDetail) job.snapshot.errorDetail = errorDetail;
  if (state === 'done' || state === 'failed' || state === 'cancelled') {
    job.snapshot.finishedAt = Date.now();
    job.snapshot.currentIndex = -1;
  }
  emit(job, { type: 'state', jobId: job.snapshot.jobId, state, error, errorDetail });
}

export function setItemState(
  job: TransferJobRecord,
  index: number,
  patch: { state?: TransferItemState; transferredBytes?: number; error?: TransferErrorCode }
): void {
  const item = job.snapshot.items[index];
  if (!item) return;
  if (patch.state) item.state = patch.state;
  if (patch.transferredBytes !== undefined) item.transferredBytes = patch.transferredBytes;
  if (patch.error) item.error = patch.error;
  emit(job, { type: 'item', jobId: job.snapshot.jobId, index, item });
}

export function setCurrentIndex(job: TransferJobRecord, index: number): void {
  job.snapshot.currentIndex = index;
}

/** 累计已传字节（含之前条目）。节流后才发事件，避免大文件把 NDJSON 刷爆。 */
export function reportProgress(job: TransferJobRecord, transferredBytes: number): void {
  job.emitProgress(transferredBytes);
}

export function flushProgress(job: TransferJobRecord, transferredBytes: number): void {
  job.tracker.set(transferredBytes);
  job.snapshot.progress = job.tracker.snapshot();
  emit(job, {
    type: 'progress',
    jobId: job.snapshot.jobId,
    currentIndex: job.snapshot.currentIndex,
    progress: job.snapshot.progress,
    updatedAt: Date.now(),
  });
}

export function cancelJob(jobId: string, uid: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.uid !== uid) return false;
  if (job.snapshot.finishedAt !== null) return false;
  job.abort.abort();
  return true;
}

export function resetTransferJobsForTests(): void {
  for (const job of jobs.values()) job.abort.abort();
  jobs.clear();
}
