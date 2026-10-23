// 两步下载：prepare（leg1 服务器→VibeTerm rsync，流式 NDJSON 进度，期间持续有数据避免空闲超时）
// → content（leg2 VibeTerm→客户端，并行 Range 拉取，见 ranged-download.ts）→ 返回 {name, blob}。
// 自身不访问 URL/document/下载锚点。支持 AbortSignal 取消；只要远端已产出 downloadId，
// 任何阶段失败都 best-effort 清理远端临时会话。

import type { FileErrorCode } from '@vibeterm/shared';
import { type ApiClient, defaultApiClient } from './client';
import {
  type FileApiError,
  TransferInterruptedError,
  fileErrorFromEvent,
  guardNetwork,
  parseError,
} from './file-errors';
import { formatBytesFixed } from './format';
import { createLegReporter } from './leg-progress';
import { readNdjsonStream } from './ndjson-stream';
import { type ContentFetchInput, fetchContentBlob } from './ranged-download';
import { DIRECT_TRANSFER_STREAMS, type TransferOpts } from './transfer-types';

interface DownloadPrepareEvent {
  type: 'progress' | 'done' | 'error';
  transferred?: number;
  totalBytes?: number;
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

/** 区间大小与退避等待可注入，供测试用小数据、零等待驱动。 */
export interface DownloadOpts extends TransferOpts {
  chunkBytes?: ContentFetchInput['chunkBytes'];
  sleep?: ContentFetchInput['sleep'];
}

export async function downloadFileWithProgress(
  rootId: string,
  path: string,
  name: string,
  opts: DownloadOpts = {},
  client: ApiClient = defaultApiClient
): Promise<DownloadedFile> {
  // downloadId 一旦由 prepare 产出，远端就已持有临时会话；后续任何失败路径都必须回收。
  let downloadId = '';

  try {
    const prepared = await prepareDownload(rootId, path, name, opts, client, (id) => {
      downloadId = id;
    });
    const blob = await drainContent(client, downloadId, prepared.size, opts);
    // 整份收齐并校验过长度之后才回收远端会话——服务端不会在读到文件尾时自行清理，
    // 否则中途断线的续传请求会撞上 404。
    await deleteDownloadSession(client, downloadId);
    return { name: prepared.name, blob };
  } catch (e) {
    if (downloadId) await deleteDownloadSession(client, downloadId);
    throw e;
  }
}

async function deleteDownloadSession(client: ApiClient, downloadId: string): Promise<void> {
  try {
    await client.fetch(`/api/files/download/${downloadId}`, {
      method: 'DELETE',
      purpose: 'transfer',
    });
  } catch {
    // 忽略
  }
}

// leg2：VibeTerm → 客户端。
async function drainContent(
  client: ApiClient,
  downloadId: string,
  size: number,
  opts: DownloadOpts
): Promise<Blob> {
  const leg2 = createLegReporter(2, size, opts.onLeg);
  leg2.report(0);
  const blob = await fetchContentBlob({
    client,
    downloadId,
    size,
    streams: Math.max(1, opts.streams ?? DIRECT_TRANSFER_STREAMS),
    signal: opts.signal,
    chunkBytes: opts.chunkBytes,
    sleep: opts.sleep,
    onProgress: (received) => leg2.report(received),
  });
  leg2.finish();
  return blob;
}

interface PrepareOutcome {
  downloadId: string;
  size: number;
  name: string;
  error: FileApiError | null;
  /** 出现过 0<pct<100 的增量进度。 */
  incremental: boolean;
}

function foldPrepareEvent(
  out: PrepareOutcome,
  ev: DownloadPrepareEvent,
  opts: TransferOpts,
  onDownloadId: (downloadId: string) => void
): void {
  if (ev.type === 'progress') {
    const pct = ev.pct ?? 0;
    if (pct > 0 && pct < 100) out.incremental = true;
    opts.onLeg?.(1, {
      pct,
      rate: ev.rate,
      detail: ev.transferred != null ? formatBytesFixed(ev.transferred) : undefined,
      bytes: ev.transferred,
      totalBytes: ev.totalBytes,
    });
  } else if (ev.type === 'done') {
    out.downloadId = ev.downloadId ?? '';
    out.size = ev.size ?? 0;
    out.name = ev.name ?? out.name;
    if (out.downloadId) onDownloadId(out.downloadId);
  } else if (ev.type === 'error') {
    out.error = fileErrorFromEvent(ev);
  }
}

// leg1：服务器 → VibeTerm（rsync）。downloadId 一拿到就通过 onDownloadId 上报，
// 保证解析中途抛错时调用方仍能回收远端会话。
// bulk 直连路径（`@vibeterm/panels` 的 downloadFileWithTransport）复用同一份 leg1，
// 因此两段权重与 leg1 收尾也在这里统一发出。
export async function prepareDownload(
  rootId: string,
  path: string,
  name: string,
  opts: TransferOpts,
  client: ApiClient,
  onDownloadId: (downloadId: string) => void
): Promise<PreparedDownload> {
  opts.onLeg?.(1, { pct: 0 });
  const prep = await guardNetwork(() =>
    client.fetch('/api/files/download/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootId, path }),
      signal: opts.signal,
      timeout: false,
      purpose: 'transfer',
    })
  );
  if (!prep.ok || !prep.body) throw await parseError(prep);

  const out: PrepareOutcome = { downloadId: '', size: 0, name, error: null, incremental: false };
  const body = prep.body;
  await guardNetwork(() =>
    readNdjsonStream<DownloadPrepareEvent>(body, (ev) =>
      foldPrepareEvent(out, ev, opts, onDownloadId)
    )
  );

  if (out.error) throw out.error;
  // 流结束既没有 done 也没有 error：连接被切断，不是服务端给的结论
  if (!out.downloadId) {
    throw new TransferInterruptedError(0, 0, new Error('prepare stream ended without done'));
  }
  opts.onLegWeights?.([out.incremental ? 1 : 0, 1]);
  opts.onLeg?.(1, {
    pct: 100,
    detail: formatBytesFixed(out.size),
    bytes: out.size,
    totalBytes: out.size,
  });
  return { downloadId: out.downloadId, size: out.size, name: out.name };
}
