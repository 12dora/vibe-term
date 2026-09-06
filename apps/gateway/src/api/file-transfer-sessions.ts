import {
  downloadSourceChanged,
  getDownloadSession,
  getUploadSession,
  removeDownloadSession,
  removeUploadSession,
  writeUploadBytes,
} from '../files/transfer-session';
import { type ContentRange, streamFileRange } from './file-http';

const transferUids = new Map<string, string>();

export type BulkTransferOwner = {
  uid: string;
  tempPath: string;
  expectedSize: number;
  kind: 'upload' | 'download';
};

/**
 * RTC bulk 直连与 REST 会话之间的窄接口。区间化之后上传写入带偏移、下载读取带区间，
 * 两条路径共用同一个可续传 sink。
 */
export type FilesBulkHooks = {
  status(transferId: string): BulkTransferOwner | null;
  writeRange(
    transferId: string,
    offset: number,
    bytes: Uint8Array
  ): Promise<{ ok: true; received: number } | { ok: false; code: string }>;
  openRange(transferId: string, range?: ContentRange | null): ReadableStream<Uint8Array> | null;
  abort(transferId: string): void;
};

export function rememberTransferUid(transferId: string, uid: string): void {
  transferUids.set(transferId, uid);
}

function forgetTransferUid(transferId: string): void {
  transferUids.delete(transferId);
}

export function cleanupUpload(id: string): void {
  removeUploadSession(id);
  forgetTransferUid(id);
}

export function cleanupDownload(id: string): void {
  removeDownloadSession(id);
  forgetTransferUid(id);
}

export function getTransferOwner(transferId: string): BulkTransferOwner | null {
  const upload = getUploadSession(transferId);
  if (upload) {
    return {
      uid: transferUids.get(transferId) ?? '',
      tempPath: upload.tmpPath,
      expectedSize: upload.size,
      kind: 'upload',
    };
  }
  const download = getDownloadSession(transferId);
  if (download) {
    return {
      uid: transferUids.get(transferId) ?? '',
      tempPath: download.tmpPath,
      expectedSize: download.size,
      kind: 'download',
    };
  }
  return null;
}

export function openDownload(
  transferId: string,
  range?: ContentRange | null
): ReadableStream<Uint8Array> | null {
  const session = getDownloadSession(transferId);
  if (!session) return null;
  if (downloadSourceChanged(session)) {
    cleanupDownload(transferId);
    return null;
  }
  // 会话由客户端显式 DELETE 或 TTL 回收；读完最后一个字节不等于对端收全了。
  return streamFileRange(session.tmpPath, range ?? null);
}

export async function appendUpload(
  transferId: string,
  offset: number,
  bytes: Uint8Array
): Promise<{ ok: true; received: number } | { ok: false; code: string }> {
  const session = getUploadSession(transferId);
  if (!session) return { ok: false, code: 'not_found' };
  const res = await writeUploadBytes(transferId, offset, bytes);
  if (!res.ok) {
    if (res.reason === 'too_large') return { ok: false, code: 'too_large' };
    if (res.reason === 'not_found') return { ok: false, code: 'not_found' };
    return { ok: false, code: 'invalid' };
  }
  return { ok: true, received: res.received };
}

export function abortTransfer(transferId: string): void {
  if (getUploadSession(transferId)) cleanupUpload(transferId);
  if (getDownloadSession(transferId)) cleanupDownload(transferId);
}

export const filesBulkHooks: FilesBulkHooks = {
  status: getTransferOwner,
  writeRange: appendUpload,
  openRange: openDownload,
  abort: abortTransfer,
};
