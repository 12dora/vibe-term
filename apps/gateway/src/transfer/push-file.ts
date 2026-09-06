// 单个文件的推送：源侧取字节（ssh 源先 rsync 拉到本机暂存）→ runPush 推区间 → 落位。
// 暂存可能很慢，期间要给目标会话续期，否则等第一段字节到达时会话已经被空闲 GC 收掉了。

import type { TransferErrorCode } from '@vibeterm/shared';
import { type ByteRange, runPush } from '@vibeterm/transfer';
import { openRange } from '@vibeterm/transfer/node';
import { type PulledFile, pullFileFromDevice } from '../files/device-storage';
import { abortableSleep } from '../system/remote-upgrade-io';
import type { TransferChannel } from './channel';
import { normalizeTransferError } from './errors';
import type { ExpandedEntry } from './expand';
import { type TransferJobRecord, reportProgress, setItemState } from './job-registry';
import type { OpenSessionResult } from './receiver';

const PUSH_MAX_ATTEMPTS = 5;
const FILE_DEADLINE_MS = 6 * 60 * 60 * 1000;
const KEEP_ALIVE_INTERVAL_MS = 2 * 60_000;

export type PushOneResult =
  | { kind: 'done' }
  | { kind: 'skipped' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; code: TransferErrorCode; detail?: string };

export interface PushFileContext {
  job: TransferJobRecord;
  channel: TransferChannel;
  session: OpenSessionResult;
  streams: number;
  entry: ExpandedEntry;
  index: number;
  baseBytes: number;
}

/** 源侧暂存期间给目标会话续期；`pullFileFromDevice` 对本机设备也可能是一次完整拷贝。 */
async function withKeepAlive<T>(ctx: PushFileContext, run: () => Promise<T>): Promise<T> {
  const signal = ctx.job.abort.signal;
  const timer = setInterval(() => {
    void ctx.channel.keepAlive(ctx.session.sessionId, signal).catch(() => undefined);
  }, KEEP_ALIVE_INTERVAL_MS);
  timer.unref?.();
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

function openRangeFor(path: string, range: ByteRange): ReadableStream<Uint8Array> {
  return openRange(path, range.offset, range.offset + range.length);
}

export async function pushFile(ctx: PushFileContext): Promise<PushOneResult> {
  const signal = ctx.job.abort.signal;
  if (signal.aborted) return { kind: 'cancelled' };
  const pulled = await withKeepAlive(ctx, () =>
    pullFileFromDevice(ctx.entry.rootId, ctx.entry.absPath, { signal })
  );
  if (!pulled.ok) {
    if (signal.aborted) return { kind: 'cancelled' };
    return { kind: 'failed', code: normalizeTransferError(pulled.code), detail: pulled.detail };
  }
  try {
    return await pushPulled(ctx, pulled.data);
  } finally {
    pulled.data.cleanup();
  }
}

async function pushPulled(ctx: PushFileContext, source: PulledFile): Promise<PushOneResult> {
  const { job, channel, session, index, baseBytes } = ctx;
  const signal = job.abort.signal;
  const target = { relPath: ctx.entry.relPath, size: source.size };
  const result = await runPush(
    {
      status: (s) => channel.status(session.sessionId, target, s),
      put: (range, opts) =>
        channel.put(session.sessionId, target, range, openRangeFor(source.tmpPath, range), opts),
    },
    {
      totalBytes: source.size,
      streams: ctx.streams,
      maxRangeBytes: session.chunkSize,
      maxAttempts: PUSH_MAX_ATTEMPTS,
      deadlineMs: Date.now() + FILE_DEADLINE_MS,
      signal,
      sleep: abortableSleep,
      onProgress: (bytes) => {
        reportProgress(job, baseBytes + bytes, { index, transferredBytes: bytes });
      },
    }
  );
  if (signal.aborted) return { kind: 'cancelled' };
  if (result.kind === 'cancelled') {
    // 驱动自己收掉了本轮（期限/内部中止），但任务没被取消：算失败，别谎报成取消
    return { kind: 'failed', code: 'cancelled' };
  }
  if (result.kind === 'failed') return classifyPushFailure(result.error);
  const committed = await channel.commit(session.sessionId, target, signal);
  if (signal.aborted) return { kind: 'cancelled' };
  if (!committed.ok) {
    if (committed.code === 'dest_exists') return { kind: 'skipped' };
    return { kind: 'failed', code: committed.code, detail: committed.detail };
  }
  if (committed.skipped) return { kind: 'skipped' };
  setItemState(job, index, { transferredBytes: source.size });
  return { kind: 'done' };
}

function classifyPushFailure(error: string): PushOneResult {
  const code = normalizeTransferError(error);
  if (code === 'dest_exists') return { kind: 'skipped' };
  return { kind: 'failed', code, detail: code === 'unknown' ? error : undefined };
}
