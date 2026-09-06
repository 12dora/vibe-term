// 两步下载：prepare（leg1 服务器→tmex rsync，流式 NDJSON 进度，期间持续有数据避免空闲超时）
// → content（leg2 tmex→客户端，读流计速）→ 返回 {name, blob}。自身不访问 URL/document/下载锚点。
// 支持 AbortSignal 取消；只要远端已产出 downloadId，任何阶段失败都 best-effort 清理远端临时会话。

import type { FileErrorCode } from '@tmex/shared';
import { ProgressTracker } from '@tmex/transfer';
import { type ApiClient, defaultApiClient } from './client';
import { FileApiError, parseError } from './file-errors';
import { formatBytes, formatBytesPair, formatRate } from './format';
import { readNdjsonStream } from './ndjson-stream';
import type { TransferOpts } from './transfer-types';

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

interface DownloadPrepareEvent {
  type: 'progress' | 'done' | 'error';
  transferred?: number;
  pct?: number;
  rate?: string;
  downloadId?: string;
  size?: number;
  name?: string;
  code?: FileErrorCode;
  detail?: string;
}

/** 下载传输完成结果：内容与文件名；宿主侧 save 与传输分离。 */
export interface DownloadedFile {
  name: string;
  blob: Blob;
}

/** leg1 完成后的远端临时会话句柄。 */
export interface PreparedDownload {
  downloadId: string;
  size: number;
  name: string;
}

export async function downloadFileWithProgress(
  rootId: string,
  path: string,
  name: string,
  opts: TransferOpts = {},
  client: ApiClient = defaultApiClient
): Promise<DownloadedFile> {
  const { onLeg } = opts;

  // downloadId 一旦由 prepare 产出，远端就已持有临时会话；后续任何失败路径都必须回收。
  let downloadId = '';

  try {
    const prepared = await prepareDownload(rootId, path, name, opts, client, (id) => {
      downloadId = id;
    });
    onLeg?.(1, { pct: 100, detail: formatBytes(prepared.size) });
    const blob = await drainContent(client, downloadId, prepared.size, opts);
    return { name: prepared.name, blob };
  } catch (e) {
    if (downloadId) {
      try {
        await client.fetch(`/api/files/download/${downloadId}`, { method: 'DELETE' });
      } catch {
        // 忽略
      }
    }
    throw e;
  }
}

/** 内容失败后允许重开的次数；每次都带 `Range` 从已收偏移接着拉，不重跑 prepare。 */
const CONTENT_MAX_ATTEMPTS = 3;

interface ContentState {
  chunks: Uint8Array[];
  received: number;
}

/** 读一段响应体到累积缓冲；抛错交给调用方按已收字节数续传。 */
async function readContentBody(
  body: ReadableStream<Uint8Array>,
  state: ContentState,
  total: number,
  report: (received: number, total: number) => void
): Promise<void> {
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (!value?.byteLength) continue;
    state.chunks.push(value);
    state.received += value.byteLength;
    report(state.received, total);
  }
}

// leg2：tmex → 客户端。链路中断按已收字节数续传（服务端支持 `Range`）。
async function drainContent(
  client: ApiClient,
  downloadId: string,
  size: number,
  opts: TransferOpts
): Promise<Blob> {
  const { onLeg, signal } = opts;
  const bytes = (n: number) => formatBytesPair(n, size);
  onLeg?.(2, { pct: 0, detail: bytes(0) });
  const tracker = new ProgressTracker({ totalBytes: size });
  const report = (received: number, total: number): void => {
    tracker.set(received);
    onLeg?.(2, {
      pct: total > 0 ? Math.round((received / total) * 100) : 0,
      rate: tracker.ratePerSec() > 0 ? formatRate(tracker.ratePerSec()) : undefined,
      detail: formatBytesPair(received, total),
    });
  };
  const state: ContentState = { chunks: [], received: 0 };
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= CONTENT_MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw abortError();
    const headers = state.received > 0 ? { Range: `bytes=${state.received}-` } : undefined;
    const res = await client.fetch(`/api/files/download/${downloadId}/content`, {
      headers,
      signal,
    });
    if (!res.ok || !res.body) throw await parseError(res);
    if (state.received > 0 && res.status !== 206) {
      // 对端不认 Range，只能整份重来
      state.chunks = [];
      state.received = 0;
    }
    const total = size > 0 ? size : Number(res.headers.get('Content-Length') ?? '0');
    try {
      await readContentBody(res.body, state, total, report);
      if (size > 0 && state.received < size) {
        throw new FileApiError(500, `download truncated: ${state.received}/${size}`, 'unknown');
      }
    } catch (err) {
      if (signal?.aborted) throw abortError();
      lastError = err;
      continue;
    }
    onLeg?.(2, { pct: 100, detail: bytes(size) });
    return new Blob(state.chunks as BlobPart[]);
  }
  throw lastError instanceof Error
    ? lastError
    : new FileApiError(500, 'download failed', 'unknown');
}

// leg1：服务器 → tmex（rsync）。downloadId 一拿到就通过 onDownloadId 上报，
// 保证解析中途抛错时调用方仍能回收远端会话。
// bulk 直连路径（`@tmex/panels` 的 downloadFileWithTransport）复用同一份 leg1。
export async function prepareDownload(
  rootId: string,
  path: string,
  name: string,
  opts: TransferOpts,
  client: ApiClient,
  onDownloadId: (downloadId: string) => void
): Promise<PreparedDownload> {
  const { onLeg, signal } = opts;

  onLeg?.(1, { pct: 0 });
  const prep = await client.fetch('/api/files/download/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootId, path }),
    signal,
  });
  if (!prep.ok || !prep.body) throw await parseError(prep);

  let downloadId = '';
  let size = 0;
  let dlName = name;
  let prepErr: FileApiError | null = null;

  await readNdjsonStream<DownloadPrepareEvent>(prep.body, (ev) => {
    if (ev.type === 'progress') {
      onLeg?.(1, {
        pct: ev.pct ?? 0,
        rate: ev.rate,
        detail: ev.transferred != null ? formatBytes(ev.transferred) : undefined,
      });
    } else if (ev.type === 'done') {
      downloadId = ev.downloadId ?? '';
      size = ev.size ?? 0;
      dlName = ev.name ?? name;
      if (downloadId) onDownloadId(downloadId);
    } else if (ev.type === 'error') {
      prepErr = new FileApiError(500, ev.detail ?? ev.code ?? 'unknown', ev.code);
    }
  });

  if (prepErr) throw prepErr;
  if (!downloadId) throw new FileApiError(500, 'unknown', 'unknown');
  return { downloadId, size, name: dlName };
}
