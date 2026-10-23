// 文件传输的路径选择：能直连（bulk DataChannel）就走直连，否则/失败就整次回落 REST。
//
// 设计依据 `docs/architecture/mesh-architecture.md` §3「bulk 协议」、§4「连接层」。
// 与纯 REST 路径（`@vibeterm/api-client` 的 `uploadFileChunked` / `downloadFileWithProgress`）
// 的差别只在「浏览器 ↔ node 的那一段字节」：
//
//   上传：REST `init` → bulk 送字节 → REST `commit`（leg2 的 rsync 与 REST 路径完全一致）
//   下载：REST `prepare` → bulk 收字节
//
// 回落规则（v1 重试语义）：
//   * `self` 永不走直连（同进程，没有直连可言）；
//   * 直连不可用或 **commit 之前**任一步失败 → 先回收本次会话，再用原 REST 路径重跑整次传输；
//   * **commit 已经开始就不再回落**——否则会对同一个文件写两次；
//   * 用户取消（AbortError）一律直接上抛，不回落。

import {
  type ApiClient,
  type DownloadedFile,
  FileApiError,
  SELF_NODE_ID,
  defaultApiClient,
  downloadFileWithProgress,
  uploadFileChunked,
} from '@vibeterm/api-client';
import { prepareDownload } from '@vibeterm/api-client/download-transfer';
import { abortError } from '@vibeterm/api-client/file-errors';
import { createLegReporter } from '@vibeterm/api-client/leg-progress';
import type { TransferOpts } from '@vibeterm/api-client/transfer-types';
import { commitUpload, initUpload } from '@vibeterm/api-client/upload-transfer';
import { getBulkClient } from '@vibeterm/ws-client/direct/bulk-client';

/** 本次传输实际走的通道：`direct` = 浏览器↔node 直连，`relay` = 经中继中转的 REST。 */
export type TransferPath = 'direct' | 'relay';

/** `@vibeterm/ws-client` 的 `BulkClient` 结构子集（测试可注入假件）。 */
export interface FileBulkClient {
  isAvailable(): boolean;
  upload(req: {
    transferId: string;
    size: number;
    source: Blob | ReadableStream<Uint8Array>;
    signal?: AbortSignal;
    onProgress?: (sent: number, total: number) => void;
  }): Promise<{ ok: true } | { ok: false; code: string }>;
  download(req: {
    transferId: string;
    signal?: AbortSignal;
    onProgress?: (received: number) => void;
  }): ReadableStream<Uint8Array>;
}

export interface TransferPathOpts extends TransferOpts {
  /** 路径确定后回调一次，用于进度 UI 上的 direct / relay 徽标。 */
  onPath?: (path: TransferPath) => void;
}

export interface BulkTransferDeps {
  /** 缺省按 nodeId 查 ws-client 的登记表；测试注入假件。 */
  resolveBulk?: (nodeId: string) => FileBulkClient | null;
}

/** commit 之前的失败：可以整次回落 REST。 */
class BulkStageError extends Error {
  constructor(readonly cause: unknown) {
    super('bulk stage failed');
    this.name = 'BulkStageError';
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * 取消语义：清理（DELETE 回收）期间用户点了取消时，抛的必须是标准 `AbortError`，
 * 否则调用方按 `err.name === 'AbortError'` 判断会漏判。已经是 AbortError 的原样上抛。
 * 没被取消则原地返回，由调用方决定是否回落 REST。
 */
function rethrowIfCanceled(err: unknown, signal?: AbortSignal | null): void {
  if (isAbortError(err)) throw err;
  if (signal?.aborted) throw abortError();
}

function pickBulk(nodeId: string, deps?: BulkTransferDeps): FileBulkClient | null {
  if (!nodeId || nodeId === SELF_NODE_ID) return null;
  const resolve = deps?.resolveBulk ?? ((id: string) => getBulkClient(id) as FileBulkClient | null);
  const client = resolve(nodeId);
  if (!client) return null;
  try {
    return client.isAvailable() ? client : null;
  } catch {
    return null;
  }
}

async function deleteQuietly(client: ApiClient, path: string): Promise<void> {
  try {
    await client.fetch(path, { method: 'DELETE', purpose: 'transfer' });
  } catch {
    // best-effort 回收
  }
}

// ========== 上传 ==========

export async function uploadFileWithTransport(
  nodeId: string,
  rootId: string,
  destDir: string,
  file: File,
  opts: TransferPathOpts = {},
  client: ApiClient = defaultApiClient,
  deps?: BulkTransferDeps
): Promise<TransferPath> {
  const bulk = pickBulk(nodeId, deps);
  if (bulk) {
    opts.onPath?.('direct');
    try {
      await uploadViaBulk(rootId, destDir, file, opts, client, bulk);
      return 'direct';
    } catch (err) {
      if (!(err instanceof BulkStageError)) throw err;
      // 落到下面的 REST 整次重传（bulk 会话已回收，不会重复 commit）
    }
  }
  opts.onPath?.('relay');
  await uploadFileChunked(rootId, destDir, file, opts, client);
  return 'relay';
}

async function uploadViaBulk(
  rootId: string,
  destDir: string,
  file: File,
  opts: TransferPathOpts,
  client: ApiClient,
  bulk: FileBulkClient
): Promise<void> {
  const { signal } = opts;
  const total = file.size;
  let uploadId = '';

  try {
    uploadId = (await initUpload(client, rootId, destDir, file, opts)).uploadId;
    if (!uploadId) throw new FileApiError(500, 'unknown', 'unknown');
    await sendViaBulk(bulk, uploadId, file, opts);
  } catch (err) {
    if (uploadId) await deleteQuietly(client, `/api/files/upload/${uploadId}`);
    rethrowIfCanceled(err, signal);
    throw new BulkStageError(err);
  }

  // leg2：node → 服务器（rsync）。commit 一旦开始就不再回落，避免重复写入。
  try {
    await commitUpload(client, uploadId, opts, total);
  } catch (err) {
    await deleteQuietly(client, `/api/files/upload/${uploadId}`);
    throw err;
  }
}

// leg1：浏览器 → node（直连 DataChannel）。
async function sendViaBulk(
  bulk: FileBulkClient,
  uploadId: string,
  file: File,
  opts: TransferPathOpts
): Promise<void> {
  const total = file.size;
  const leg1 = createLegReporter(1, total, opts.onLeg);
  leg1.report(0);
  // 送出的字节数必须与 init 登记的一致：多了 bulk 客户端自己会 abort，少了 node 会回
  // `{ok:false, invalid}`；这里再自己核一遍，避免任何一侧漏判后把截断文件 commit 上去。
  let sentBytes = 0;
  const result = await bulk.upload({
    transferId: uploadId,
    size: total,
    source: file,
    signal: opts.signal,
    onProgress: (sent) => {
      sentBytes = sent;
      leg1.report(sent);
    },
  });
  if (!result.ok) throw new FileApiError(500, `bulk_${result.code}`);
  if (sentBytes !== total) throw new FileApiError(500, `bulk_size_mismatch:${sentBytes}/${total}`);
  leg1.finish();
}

// ========== 下载 ==========

export interface TransportedFile extends DownloadedFile {
  transferPath: TransferPath;
}

export async function downloadFileWithTransport(
  nodeId: string,
  rootId: string,
  path: string,
  name: string,
  opts: TransferPathOpts = {},
  client: ApiClient = defaultApiClient,
  deps?: BulkTransferDeps
): Promise<TransportedFile> {
  const bulk = pickBulk(nodeId, deps);
  if (bulk) {
    let downloadId = '';
    opts.onPath?.('direct');
    try {
      const prepared = await prepareDownload(rootId, path, name, opts, client, (id) => {
        downloadId = id;
      });
      const blob = await drainBulkDownload(bulk, downloadId, prepared.size, opts);
      await deleteQuietly(client, `/api/files/download/${downloadId}`);
      return { name: prepared.name, blob, transferPath: 'direct' };
    } catch (err) {
      if (downloadId) await deleteQuietly(client, `/api/files/download/${downloadId}`);
      rethrowIfCanceled(err, opts.signal);
      // 回落：重跑一次完整 REST（prepare 会重新拉一份临时文件）
    }
  }
  opts.onPath?.('relay');
  const file = await downloadFileWithProgress(rootId, path, name, opts, client);
  return { ...file, transferPath: 'relay' };
}

async function drainBulkDownload(
  bulk: FileBulkClient,
  downloadId: string,
  size: number,
  opts: TransferPathOpts
): Promise<Blob> {
  const leg2 = createLegReporter(2, size, opts.onLeg);
  leg2.report(0);
  const stream = bulk.download({
    transferId: downloadId,
    signal: opts.signal,
    onProgress: (received) => leg2.report(received),
  });
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  // 收到的字节必须与 prepare 声明的 size 严格相等：多了会无限撑爆页面内存，
  // 少了（node 提前 eof）会把截断内容当成完整文件保存下来。两种都当 bulk 失败回落 REST。
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > size) {
        throw new FileApiError(500, `bulk_size_overflow:${received}/${size}`);
      }
      chunks.push(value);
    }
    if (received !== size) {
      throw new FileApiError(500, `bulk_size_mismatch:${received}/${size}`);
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      // 流可能已经 error；取消只是尽力向 node 发 abort
    }
    throw err;
  }
  leg2.finish();
  return new Blob(chunks as BlobPart[]);
}
