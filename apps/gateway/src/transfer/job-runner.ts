// 任务在源节点 A 上跑：建会话 → 展开 → 逐条推送/建目录 → 收尾。
// 展开必须在会话建起来之后：grant 没过就开始遍历目录，等于让未授权的调用方白使唤一遍磁盘。

import type { TransferErrorCode, TransferJobItem } from '@vibeterm/shared';
import type { ChannelResult, TransferChannel } from './channel';
import { errorDetailOf, normalizeTransferError } from './errors';
import { type ExpandedEntry, expandItems } from './expand';
import {
  type TransferJobRecord,
  flushProgress,
  setCurrentIndex,
  setItemState,
  setJobExpanding,
  setJobItems,
  setJobState,
} from './job-registry';
import { type PushOneResult, pushFile } from './push-file';
import type { OpenSessionResult } from './receiver';

export interface RunJobInput {
  job: TransferJobRecord;
  channel: TransferChannel;
  grant: { grantId: string; token: string };
  items: readonly { rootId: string; path: string }[];
  onConflict: 'skip' | 'overwrite';
  streams: number;
}

function toItem(entry: ExpandedEntry): TransferJobItem {
  return {
    relPath: entry.relPath,
    type: entry.type,
    size: entry.size,
    state: entry.error ? 'failed' : 'pending',
    transferredBytes: 0,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

/**
 * 外层护栏：任何未预期的异常都要收成终态，否则任务永远停在 running，
 * 订阅者等不到 `end`，完成态 GC 也永远碰不到它。
 */
export async function runTransferJob(input: RunJobInput): Promise<void> {
  const { job } = input;
  try {
    await runJob(input);
  } catch (err) {
    finalize(job, errorDetailOf(err));
    return;
  }
  finalize(job);
}

function finalize(job: TransferJobRecord, detail?: string): void {
  if (job.snapshot.finishedAt !== null) return;
  if (job.abort.signal.aborted) {
    setJobState(job, 'cancelled', 'cancelled');
    return;
  }
  setJobState(job, 'failed', normalizeTransferError(detail), detail);
}

async function runJob(input: RunJobInput): Promise<void> {
  const { job, channel } = input;
  const signal = job.abort.signal;
  setJobState(job, 'running');
  if (signal.aborted) return setJobState(job, 'cancelled', 'cancelled');

  const opened = await channel.open(input.grant, input.onConflict, signal);
  if (!opened.ok) {
    if (signal.aborted) return setJobState(job, 'cancelled', 'cancelled');
    return setJobState(job, 'failed', opened.code, opened.detail);
  }
  try {
    const expanded = await expandItems(input.items, {
      maxFileBytes: opened.maxFileBytes,
      signal,
    });
    if (!expanded.ok) {
      const cancelled = signal.aborted || expanded.code === 'cancelled';
      return setJobState(
        job,
        cancelled ? 'cancelled' : 'failed',
        cancelled ? 'cancelled' : expanded.code,
        expanded.detail
      );
    }
    setJobItems(job, expanded.entries.map(toItem));
    setJobExpanding(job, false);
    await pushAll(input, expanded.entries, opened);
  } finally {
    await channel.close(opened.sessionId).catch(() => undefined);
  }
}

interface Progress {
  done: number;
  failure: { code: TransferErrorCode; detail?: string } | null;
}

async function pushAll(
  input: RunJobInput,
  entries: readonly ExpandedEntry[],
  session: OpenSessionResult
): Promise<void> {
  const { job } = input;
  const signal = job.abort.signal;
  const progress: Progress = { done: 0, failure: null };

  for (const [index, entry] of entries.entries()) {
    if (signal.aborted) return setJobState(job, 'cancelled', 'cancelled');
    if (entry.error) {
      // 展开阶段就判死的条目（超单文件上限、目标路径撞车）：不去碰链路，但整个任务算失败
      progress.failure ??= { code: entry.error };
      continue;
    }
    setCurrentIndex(job, index);
    setItemState(job, index, { state: 'running' });
    const result =
      entry.type === 'dir'
        ? await makeDir(input, session, entry, signal)
        : await pushFile({
            job,
            channel: input.channel,
            session,
            streams: input.streams,
            entry,
            index,
            baseBytes: progress.done,
          });
    if (result.kind === 'cancelled') return setJobState(job, 'cancelled', 'cancelled');
    applyResult(job, index, entry, result, progress);
  }
  flushProgress(job, progress.done);
  if (signal.aborted) return setJobState(job, 'cancelled', 'cancelled');
  if (progress.failure) {
    setJobState(job, 'failed', progress.failure.code, progress.failure.detail);
    return;
  }
  setJobState(job, 'done');
}

function applyResult(
  job: TransferJobRecord,
  index: number,
  entry: ExpandedEntry,
  result: PushOneResult,
  progress: Progress
): void {
  if (result.kind === 'skipped') {
    setItemState(job, index, { state: 'skipped' });
    progress.done += entry.size;
    return;
  }
  if (result.kind === 'failed') {
    setItemState(job, index, { state: 'failed', error: result.code });
    progress.failure = { code: result.code, detail: result.detail };
    return;
  }
  setItemState(job, index, { state: 'done', transferredBytes: entry.size });
  progress.done += entry.size;
  flushProgress(job, progress.done);
}

async function makeDir(
  input: RunJobInput,
  session: OpenSessionResult,
  entry: ExpandedEntry,
  signal: AbortSignal
): Promise<PushOneResult> {
  const made = await input.channel.mkdir(session.sessionId, entry.relPath, signal);
  if (signal.aborted) return { kind: 'cancelled' };
  if (made.ok) return { kind: 'done' };
  return { kind: 'failed', code: made.code, detail: made.detail };
}

export type { ChannelResult };
