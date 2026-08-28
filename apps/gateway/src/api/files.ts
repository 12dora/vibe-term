import {
  appendUploadChunk,
  getDownloadSession,
  getUploadSession,
  removeDownloadSession,
  removeUploadSession,
} from '../files/transfer-session';
import { fileBrowserRoutes } from './file-browser-routes';
import { streamTempFile } from './file-http';
import { fileRootRoutes } from './file-root-routes';
import { fileTransferRoutes } from './file-transfer-routes';
import type { ApiRoute } from './route';

const transferUids = new Map<string, string>();

export type BulkTransferOwner = {
  uid: string;
  tempPath: string;
  expectedSize: number;
  kind: 'upload' | 'download';
};

export type FilesBulkHooks = {
  getTransferOwner(transferId: string): BulkTransferOwner | null;
  openDownload(transferId: string): ReadableStream<Uint8Array> | null;
  appendUpload(
    transferId: string,
    bytes: Uint8Array
  ): { ok: true; received: number } | { ok: false; code: string };
  abortTransfer(transferId: string): void;
};

export function rememberTransferUid(transferId: string, uid: string): void {
  transferUids.set(transferId, uid);
}

function forgetTransferUid(transferId: string): void {
  transferUids.delete(transferId);
}

function cleanupUpload(id: string): void {
  removeUploadSession(id);
  forgetTransferUid(id);
}

function cleanupDownload(id: string): void {
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

export function openDownload(transferId: string): ReadableStream<Uint8Array> | null {
  const session = getDownloadSession(transferId);
  if (!session) return null;
  return streamTempFile(session.tmpPath, () => cleanupDownload(transferId));
}

export function appendUpload(
  transferId: string,
  bytes: Uint8Array
): { ok: true; received: number } | { ok: false; code: string } {
  const session = getUploadSession(transferId);
  if (!session) return { ok: false, code: 'not_found' };
  const res = appendUploadChunk(transferId, session.received, bytes);
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
  getTransferOwner,
  openDownload,
  appendUpload,
  abortTransfer,
};

export const filesRoutes: ApiRoute[] = [
  ...fileRootRoutes,
  ...fileBrowserRoutes,
  ...fileTransferRoutes,
];
