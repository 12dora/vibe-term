// 分块上传：init → 并行区间 PUT（leg1 浏览器→tmex）→ commit 流式 NDJSON（leg2 tmex→服务器 rsync）。
// leg1 交给 `@tmex/transfer` 的推送驱动：失败按已收区间续传，不再整包重来。

import type { UploadCommitEvent, UploadInitRequest, UploadInitResponse } from '@tmex/shared';
import { ProgressTracker, type PushTransport, runPush } from '@tmex/transfer';
import { type ApiClient, defaultApiClient } from './client';
import { FileApiError, parseError } from './file-errors';
import { formatBytesPair, formatRate } from './format';
import { readNdjsonStream } from './ndjson-stream';
import type { TransferOpts } from './transfer-types';

const UPLOAD_CHUNK_FALLBACK = 8 * 1024 * 1024;
/** 直连默认 4 条并行流；经中继时上层会压到 2（中继按流计配额）。 */
export const DEFAULT_UPLOAD_STREAMS = 4;
const UPLOAD_MAX_ATTEMPTS = 4;
const UPLOAD_DEADLINE_MS = 6 * 60 * 60 * 1000;

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

type UploadStatusResponse = {
  size?: number;
  received?: number;
  complete?: boolean;
  ranges?: Array<[number, number]>;
};

/**
 * 上传会话的推送通道。第一轮不问已收区间（刚建的会话必然是空的），
 * 之后每轮都问一次，只补发缺口。
 */
function uploadTransport(
  client: ApiClient,
  uploadId: string,
  file: Blob,
  signal: AbortSignal | undefined,
  ranged: boolean
): PushTransport {
  let asked = false;
  return {
    // 状态查询也走本轮的带期限信号：卡死的响应不能把整轮尝试吊在这里。
    async status(attemptSignal) {
      if (!asked) {
        asked = true;
        return null;
      }
      try {
        const res = await client.fetch(`/api/files/upload/${uploadId}`, { signal: attemptSignal });
        if (!res.ok) return null;
        const body = (await res.json()) as UploadStatusResponse;
        const ranges = (body.ranges ?? []).map(([offset, length]) => ({ offset, length }));
        return {
          receivedBytes: body.received ?? 0,
          ranges: ranged ? ranges : [],
          complete: body.complete === true,
        };
      } catch {
        return null;
      }
    },
    async put(range, opts) {
      if (signal?.aborted) return { kind: 'cancelled' };
      if (opts.signal.aborted) return { kind: 'retry', error: 'upload attempt aborted' };
      const query = `?offset=${range.offset}&length=${range.length}`;
      let res: Response;
      try {
        // 请求与响应体都挂在本轮信号上：期限一到或本轮已出结论，在飞的 PUT 立刻收掉。
        res = await client.fetch(`/api/files/upload/${uploadId}${query}`, {
          method: 'PUT',
          body: file.slice(range.offset, range.offset + range.length),
          signal: opts.signal,
        });
      } catch (err) {
        if (signal?.aborted) return { kind: 'cancelled' };
        return { kind: 'retry', error: err instanceof Error ? err.message : String(err) };
      }
      if (res.ok) {
        await res.text().catch(() => '');
        opts.onProgress(range.length);
        return { kind: 'landed' };
      }
      if (signal?.aborted) return { kind: 'cancelled' };
      const error = await parseError(res);
      // 409 = 半截区间 / 区间冲突，5xx = 链路或服务端抖动；都可以退避后按新偏移续传。
      return res.status === 409 || res.status >= 500
        ? { kind: 'retry', error: error.message }
        : { kind: 'fail', error: error.message };
    },
  };
}

export async function uploadFileChunked(
  rootId: string,
  destDir: string,
  file: File,
  opts: TransferOpts = {},
  client: ApiClient = defaultApiClient
): Promise<void> {
  const { onLeg, signal } = opts;
  const total = file.size;
  const bytes = (n: number) => formatBytesPair(n, total);
  const initBody: UploadInitRequest = { rootId, path: destDir, name: file.name, size: total };
  const initRes = await client.fetch('/api/files/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initBody),
    signal,
  });
  if (!initRes.ok) throw await parseError(initRes);
  const init = (await initRes.json()) as UploadInitResponse;
  const uploadId = init.uploadId;
  const step = init.chunkSize > 0 ? init.chunkSize : UPLOAD_CHUNK_FALLBACK;
  const ranged = init.ranged === true;

  try {
    await pushUploadBody({ client, uploadId, file, step, ranged, opts, total });
    onLeg?.(1, { pct: 100, detail: bytes(total) });
    await commitUpload({ client, uploadId, opts, total });
  } catch (e) {
    // 失败/取消：通知后端中止 rsync + 清理临时会话（best-effort）
    try {
      await client.fetch(`/api/files/upload/${uploadId}`, { method: 'DELETE' });
    } catch {
      // 忽略
    }
    throw e;
  }
}

async function pushUploadBody(input: {
  client: ApiClient;
  uploadId: string;
  file: File;
  step: number;
  ranged: boolean;
  opts: TransferOpts;
  total: number;
}): Promise<void> {
  const { client, uploadId, file, step, ranged, opts, total } = input;
  const { onLeg, signal } = opts;
  onLeg?.(1, { pct: total === 0 ? 100 : 0, detail: formatBytesPair(0, total) });
  const tracker = new ProgressTracker({ totalBytes: total });
  const result = await runPush(uploadTransport(client, uploadId, file, signal, ranged), {
    totalBytes: total,
    // 老节点只接受顺序追加，退回单流；新节点默认并行，调用方可按链路收紧。
    streams: ranged ? Math.max(1, opts.streams ?? DEFAULT_UPLOAD_STREAMS) : 1,
    maxRangeBytes: step,
    maxAttempts: UPLOAD_MAX_ATTEMPTS,
    deadlineMs: Date.now() + UPLOAD_DEADLINE_MS,
    signal: signal ?? new AbortController().signal,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onProgress: (transferred) => {
      tracker.set(transferred);
      onLeg?.(1, {
        pct: total > 0 ? Math.round((transferred / total) * 100) : 100,
        rate: tracker.ratePerSec() > 0 ? formatRate(tracker.ratePerSec()) : undefined,
        detail: formatBytesPair(transferred, total),
      });
    },
  });
  if (result.kind === 'cancelled') throw abortError();
  if (result.kind === 'failed') throw new FileApiError(500, result.error, 'unknown');
}

async function commitUpload(input: {
  client: ApiClient;
  uploadId: string;
  opts: TransferOpts;
  total: number;
}): Promise<void> {
  const { client, uploadId, opts, total } = input;
  const { onLeg, signal } = opts;
  const bytes = (n: number) => formatBytesPair(n, total);
  if (signal?.aborted) throw abortError();
  onLeg?.(2, { pct: 0, detail: bytes(0) });
  const commitRes = await client.fetch(`/api/files/upload/${uploadId}/commit`, {
    method: 'POST',
    signal,
  });
  if (!commitRes.ok || !commitRes.body) throw await parseError(commitRes);

  let done = false;
  await readNdjsonStream<UploadCommitEvent>(commitRes.body, (ev) => {
    if (ev.type === 'progress') {
      onLeg?.(2, { pct: ev.pct, rate: ev.rate, detail: bytes(ev.transferred) });
    } else if (ev.type === 'done') {
      done = true;
    } else if (ev.type === 'error') {
      throw new FileApiError(500, ev.detail ?? ev.code, ev.code);
    }
  });
  if (!done) throw new FileApiError(500, 'unknown', 'unknown');
  onLeg?.(2, { pct: 100, detail: bytes(total) });
}
