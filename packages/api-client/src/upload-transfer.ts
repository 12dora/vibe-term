// 分块上传：init → 并行区间 PUT（leg1 浏览器→VibeTerm）→ commit 流式 NDJSON（leg2 VibeTerm→服务器 rsync）。
// leg1 交给 `@vibeterm/transfer` 的推送驱动：失败按已收区间续传，不再整包重来；
// 区间内的实时上行字节由 `ApiClient.upload`（XHR）提供，进度按字节而不是按整块跳。

import type { UploadCommitEvent, UploadInitRequest, UploadInitResponse } from '@vibeterm/shared';
import { runPush } from '@vibeterm/transfer';
import { type ApiClient, defaultApiClient } from './client';
import {
  FileApiError,
  TransferInterruptedError,
  abortError,
  fileErrorFromEvent,
  guardNetwork,
  parseError,
} from './file-errors';
import { formatBytesPair } from './format';
import { createLegReporter } from './leg-progress';
import { readNdjsonStream } from './ndjson-stream';
import { DIRECT_TRANSFER_STREAMS, type TransferOpts } from './transfer-types';
import { type UploadFailureLog, createUploadTransport } from './upload-transport';

const UPLOAD_CHUNK_FALLBACK = 8 * 1024 * 1024;
const UPLOAD_MAX_ATTEMPTS = 4;
const UPLOAD_DEADLINE_MS = 6 * 60 * 60 * 1000;

/** 建上传会话，并按服务端是否推送 commit 进度给出两段权重。 */
export async function initUpload(
  client: ApiClient,
  rootId: string,
  destDir: string,
  file: File,
  opts: TransferOpts
): Promise<UploadInitResponse> {
  const initBody: UploadInitRequest = { rootId, path: destDir, name: file.name, size: file.size };
  const initRes = await guardNetwork(
    () =>
      client.fetch('/api/files/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initBody),
        signal: opts.signal,
        purpose: 'transfer',
      }),
    0,
    file.size
  );
  if (!initRes.ok) throw await parseError(initRes);
  const init = (await initRes.json()) as UploadInitResponse;
  opts.onLegWeights?.([1, init.commitProgress === false ? 0 : 1]);
  return init;
}

export async function uploadFileChunked(
  rootId: string,
  destDir: string,
  file: File,
  opts: TransferOpts = {},
  client: ApiClient = defaultApiClient
): Promise<void> {
  const total = file.size;
  const init = await initUpload(client, rootId, destDir, file, opts);
  const uploadId = init.uploadId;
  const step = init.chunkSize > 0 ? init.chunkSize : UPLOAD_CHUNK_FALLBACK;
  const ranged = init.ranged === true;

  try {
    await pushUploadBody({ client, uploadId, file, step, ranged, opts });
    await commitUpload(client, uploadId, opts, total);
  } catch (e) {
    // 失败/取消：通知后端中止 rsync + 清理临时会话（best-effort）
    try {
      await client.fetch(`/api/files/upload/${uploadId}`, {
        method: 'DELETE',
        purpose: 'transfer',
      });
    } catch {
      // 忽略
    }
    throw e;
  }
}

/** 服务端明确拒绝过就抛它给出的原因；否则是纯链路问题（断线/超时），抛「传输中断」。 */
function pushFailure(
  failure: UploadFailureLog,
  received: number,
  total: number,
  message: string
): Error {
  if (failure.error instanceof FileApiError) return failure.error;
  return new TransferInterruptedError(received, total, failure.error ?? new Error(message));
}

async function pushUploadBody(input: {
  client: ApiClient;
  uploadId: string;
  file: File;
  step: number;
  ranged: boolean;
  opts: TransferOpts;
}): Promise<void> {
  const { client, uploadId, file, step, ranged, opts } = input;
  const { signal } = opts;
  const total = file.size;
  const leg1 = createLegReporter(1, total, opts.onLeg);
  const failure: UploadFailureLog = { error: undefined };
  let transferred = 0;
  leg1.report(0);
  const result = await runPush(
    createUploadTransport({ client, uploadId, file, signal, ranged, failure }),
    {
      totalBytes: total,
      // 老节点只接受顺序追加，退回单流；新节点默认并行，调用方可按链路收紧。
      streams: ranged ? Math.max(1, opts.streams ?? DIRECT_TRANSFER_STREAMS) : 1,
      maxRangeBytes: step,
      maxAttempts: UPLOAD_MAX_ATTEMPTS,
      deadlineMs: Date.now() + UPLOAD_DEADLINE_MS,
      signal: signal ?? new AbortController().signal,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      onProgress: (bytes) => {
        transferred = bytes;
        leg1.report(bytes);
      },
    }
  );
  if (result.kind === 'cancelled') throw abortError();
  if (result.kind === 'failed') throw pushFailure(failure, transferred, total, result.error);
  leg1.finish();
}

/** leg2：触发 commit 并消费它的 NDJSON 进度（bulk 直连路径复用）。 */
export async function commitUpload(
  client: ApiClient,
  uploadId: string,
  opts: TransferOpts,
  total: number
): Promise<void> {
  const { onLeg, signal } = opts;
  if (signal?.aborted) throw abortError();
  const leg2 = createLegReporter(2, total, onLeg);
  leg2.report(0);
  // 数据已全部在 VibeTerm 上，commit 阶段断线时「已收」按全量算
  const commitRes = await guardNetwork(
    () =>
      client.fetch(`/api/files/upload/${uploadId}/commit`, {
        method: 'POST',
        signal,
        timeout: false,
        purpose: 'transfer',
      }),
    total,
    total
  );
  if (!commitRes.ok || !commitRes.body) throw await parseError(commitRes);

  const body = commitRes.body;
  let done = false;
  await guardNetwork(
    () =>
      readNdjsonStream<UploadCommitEvent>(body, (ev) => {
        if (ev.type === 'progress') {
          onLeg?.(2, {
            pct: ev.pct,
            rate: ev.rate,
            detail: formatBytesPair(ev.transferred, total),
            bytes: ev.transferred,
            totalBytes: total,
          });
        } else if (ev.type === 'done') {
          done = true;
        } else if (ev.type === 'error') {
          throw fileErrorFromEvent(ev);
        }
      }),
    total,
    total
  );
  // 流结束既没有 done 也没有 error：连接被切断，不是服务端给的结论
  if (!done) throw new TransferInterruptedError(total, total, new Error('commit stream ended'));
  leg2.finish();
}
