// 任务在源节点 A 上跑：展开 → 建会话 → 逐个文件 runPush → commit。
// 字节从本机盘直接读（`openRange`），ssh 源先 rsync 拉到本机暂存再读。

import type { TransferErrorCode, TransferJobItem } from '@tmex/shared';
import { type ByteRange, runPush } from '@tmex/transfer';
import { openRange } from '@tmex/transfer/node';
import { config } from '../config';
import { pullFileFromDevice } from '../files/device-storage';
import { transferMaxBytesNow } from '../files/transfer-limit';
import { abortableSleep } from '../system/remote-upgrade-io';
import type { ChannelVoid, TransferChannel } from './channel';
import { type ExpandedFile, expandItems } from './expand';
import {
  type TransferJobRecord,
  flushProgress,
  reportProgress,
  setCurrentIndex,
  setItemState,
  setJobExpanding,
  setJobItems,
  setJobState,
} from './job-registry';
import type { OpenSessionResult } from './receiver';

const PUSH_MAX_ATTEMPTS = 5;
const FILE_DEADLINE_MS = 6 * 60 * 60 * 1000;

export interface RunJobInput {
  job: TransferJobRecord;
  channel: TransferChannel;
  grant: { grantId: string; token: string };
  items: readonly { rootId: string; path: string }[];
  onConflict: 'skip' | 'overwrite';
  streams: number;
}

function toItem(file: ExpandedFile): TransferJobItem {
  return {
    relPath: file.relPath,
    size: file.size,
    state: file.error ? 'failed' : 'pending',
    transferredBytes: 0,
    ...(file.error ? { error: file.error } : {}),
  };
}

export async function runTransferJob(input: RunJobInput): Promise<void> {
  const { job, channel } = input;
  const signal = job.abort.signal;
  const maxFileBytes = transferMaxBytesNow(config.transferMaxBytes);
  setJobState(job, 'running');

  const expanded = await expandItems(input.items, { maxFileBytes, signal });
  if (!expanded.ok) {
    setJobState(
      job,
      expanded.code === 'cancelled' ? 'cancelled' : 'failed',
      expanded.code,
      expanded.detail
    );
    return;
  }
  setJobItems(job, expanded.files.map(toItem));
  setJobExpanding(job, false);
  if (signal.aborted) {
    setJobState(job, 'cancelled', 'cancelled');
    return;
  }

  const opened = await channel.open(input.grant, input.onConflict, signal);
  if (!opened.ok) {
    setJobState(job, 'failed', opened.code, opened.detail);
    return;
  }
  try {
    await pushAll(input, expanded.files, opened);
  } finally {
    await channel.close(opened.sessionId).catch(() => undefined);
  }
}

async function pushAll(
  input: RunJobInput,
  files: readonly ExpandedFile[],
  session: OpenSessionResult
): Promise<void> {
  const { job, channel } = input;
  const signal = job.abort.signal;
  let done = 0;
  let failure: { code: TransferErrorCode; detail?: string } | null = null;

  for (const [index, file] of files.entries()) {
    if (signal.aborted) {
      setJobState(job, 'cancelled', 'cancelled');
      return;
    }
    if (file.error) {
      // 展开阶段就判死的条目（超单文件上限）：不去碰链路，但整个任务算失败
      failure ??= { code: file.error };
      continue;
    }
    setCurrentIndex(job, index);
    setItemState(job, index, { state: 'running' });
    const result = await pushOne({ input, session, file, index, baseBytes: done });
    if (result.kind === 'cancelled') {
      setJobState(job, 'cancelled', 'cancelled');
      return;
    }
    if (result.kind === 'skipped') {
      setItemState(job, index, { state: 'skipped' });
      done += file.size;
      continue;
    }
    if (result.kind === 'failed') {
      setItemState(job, index, { state: 'failed', error: result.code });
      failure = { code: result.code, detail: result.detail };
      continue;
    }
    setItemState(job, index, { state: 'done', transferredBytes: file.size });
    done += file.size;
    flushProgress(job, done);
  }
  flushProgress(job, done);
  if (failure) setJobState(job, 'failed', failure.code, failure.detail);
  else setJobState(job, 'done');
}

type PushOneResult =
  | { kind: 'done' }
  | { kind: 'skipped' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; code: TransferErrorCode; detail?: string };

async function pushOne(ctx: {
  input: RunJobInput;
  session: OpenSessionResult;
  file: ExpandedFile;
  index: number;
  baseBytes: number;
}): Promise<PushOneResult> {
  const { input, session, file, index, baseBytes } = ctx;
  const { job, channel } = input;
  const signal = job.abort.signal;
  const source = await pullFileFromDevice(file.rootId, file.absPath, { signal });
  if (!source.ok) return { kind: 'failed', code: source.code as TransferErrorCode };
  const size = source.data.size;
  const target = { relPath: file.relPath, size };

  try {
    const result = await runPush(
      {
        status: (s) => channel.status(session.sessionId, target, s),
        put: (range, opts) =>
          channel.put(
            session.sessionId,
            target,
            range,
            openRangeFor(source.data.tmpPath, range),
            opts
          ),
      },
      {
        totalBytes: size,
        streams: input.streams,
        maxRangeBytes: session.chunkSize,
        maxAttempts: PUSH_MAX_ATTEMPTS,
        deadlineMs: Date.now() + FILE_DEADLINE_MS,
        signal,
        sleep: abortableSleep,
        onProgress: (bytes) => {
          setItemState(job, index, { transferredBytes: bytes });
          reportProgress(job, baseBytes + bytes);
        },
      }
    );
    if (result.kind === 'cancelled') return { kind: 'cancelled' };
    if (result.kind === 'failed') return classifyPushFailure(result.error);
    const committed = await channel.commit(session.sessionId, target, signal);
    return commitOutcome(committed);
  } finally {
    source.data.cleanup();
  }
}

function openRangeFor(path: string, range: ByteRange): ReadableStream<Uint8Array> {
  return openRange(path, range.offset, range.offset + range.length);
}

const FAILURE_CODES = new Set<TransferErrorCode>([
  'quota_file_size',
  'dest_exists',
  'grant_invalid',
  'grant_expired',
  'peer_mismatch',
  'checksum_mismatch',
  'too_large',
  'permission_denied',
  'outside_roots',
  'not_found',
  'invalid',
]);

function classifyPushFailure(error: string): PushOneResult {
  const code = error as TransferErrorCode;
  if (code === 'dest_exists') return { kind: 'skipped' };
  if (FAILURE_CODES.has(code)) return { kind: 'failed', code };
  return { kind: 'failed', code: 'unknown', detail: error };
}

function commitOutcome(committed: ChannelVoid): PushOneResult {
  if (committed.ok) return { kind: 'done' };
  if (committed.code === 'dest_exists') return { kind: 'skipped' };
  return { kind: 'failed', code: committed.code, detail: committed.detail };
}
