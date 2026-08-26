// 分块上传：init → 顺序 PUT 各 chunk（leg1 浏览器→tmex）→ commit 流式 NDJSON（leg2 tmex→服务器 rsync）。

import type { UploadCommitEvent, UploadInitRequest, UploadInitResponse } from '@tmex/shared';
import { type ApiClient, defaultApiClient } from './client';
import { FileApiError, parseError } from './file-errors';
import { formatBytes, formatRate } from './format';
import { readNdjsonStream } from './ndjson-stream';
import type { TransferOpts } from './transfer-types';

const UPLOAD_CHUNK_FALLBACK = 8 * 1024 * 1024;

export async function uploadFileChunked(
  rootId: string,
  destDir: string,
  file: File,
  opts: TransferOpts = {},
  client: ApiClient = defaultApiClient
): Promise<void> {
  const { onLeg, signal } = opts;
  const ensureNotAborted = () => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };
  const total = file.size;
  const bytes = (n: number) => `${formatBytes(n)} / ${formatBytes(total)}`;
  const initBody: UploadInitRequest = { rootId, path: destDir, name: file.name, size: total };
  const initRes = await client.fetch('/api/files/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initBody),
    signal,
  });
  if (!initRes.ok) throw await parseError(initRes);
  const { uploadId, chunkSize } = (await initRes.json()) as UploadInitResponse;
  const step = chunkSize > 0 ? chunkSize : UPLOAD_CHUNK_FALLBACK;

  try {
    // leg1：浏览器 → tmex（分块上传，进度客户端本地计算）
    onLeg?.(1, { pct: total === 0 ? 100 : 0, detail: bytes(0) });
    const startedAt = performance.now();
    let offset = 0;
    while (offset < total) {
      ensureNotAborted();
      const end = Math.min(offset + step, total);
      const res = await client.fetch(`/api/files/upload/${uploadId}?offset=${offset}`, {
        method: 'PUT',
        body: file.slice(offset, end),
        signal,
      });
      if (!res.ok) throw await parseError(res);
      offset = end;
      const elapsed = (performance.now() - startedAt) / 1000;
      onLeg?.(1, {
        pct: Math.round((offset / total) * 100),
        rate: elapsed > 0 ? formatRate(offset / elapsed) : undefined,
        detail: bytes(offset),
      });
    }
    onLeg?.(1, { pct: 100, detail: bytes(total) });

    // leg2：tmex → 服务器（rsync 推送，commit 流式 NDJSON 回传进度）
    ensureNotAborted();
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
