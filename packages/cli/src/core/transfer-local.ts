// 本地 ↔ 节点：分块上传（init → PUT → commit）与两步下载（prepare → Range content）。
// 不走 `@vibeterm/transfer/node`：那条入口会把 Node 专用 sink 打进浏览器包；读盘用 node:fs。

import { open } from 'node:fs/promises';
import { sleepOrAbort } from '@vibeterm/shared/async';
import { ProgressTracker, type PushTransport, runPush } from '@vibeterm/transfer';
import { CliError, InterruptError, rethrowIfAborted, throwIfAborted } from './errors';
import { assertFilesOk, filesJson, filesQuery } from './files-api';
import type { HttpClient } from './http';
import { consumeNdjson } from './transfer-ndjson';
import { type CopyProgress, pctOf } from './transfer-progress';

const CHUNK_FALLBACK = 8 * 1024 * 1024;
const UPLOAD_ATTEMPTS = 4;
const UPLOAD_DEADLINE_MS = 6 * 60 * 60 * 1000;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_BACKOFF_MS = [200, 500, 1000] as const;

interface UploadInit {
  uploadId: string;
  chunkSize: number;
  ranged?: boolean;
}

interface UploadStatus {
  received?: number;
  complete?: boolean;
  ranges?: Array<[number, number]>;
}

interface CommitEvent {
  type: 'progress' | 'done' | 'error';
  transferred?: number;
  pct?: number;
  rate?: string;
  code?: string;
  detail?: string;
}

interface PrepareEvent {
  type: 'progress' | 'done' | 'error';
  transferred?: number;
  pct?: number;
  rate?: string;
  downloadId?: string;
  size?: number;
  name?: string;
  code?: string;
  detail?: string;
}

export async function jitteredSleep(ms: number, signal: AbortSignal): Promise<void> {
  const wait = Math.max(0, Math.round(ms * (0.5 + Math.random())));
  const completed = await sleepOrAbort(wait, signal);
  if (!completed) throw new InterruptError();
}

export async function uploadLocalFile(input: {
  http: HttpClient;
  nodeId: string;
  rootId: string;
  destDir: string;
  localPath: string;
  name: string;
  size: number;
  progress: CopyProgress;
  signal?: AbortSignal;
}): Promise<void> {
  const { http, nodeId, rootId, destDir, localPath, name, size, progress, signal } = input;
  throwIfAborted(signal);
  const init = await filesJson<UploadInit>(
    http,
    nodeId,
    'POST',
    '/api/files/upload/init',
    { rootId, path: destDir, name, size },
    signal ? { signal } : {}
  );
  const uploadId = init.uploadId;
  const step = init.chunkSize > 0 ? init.chunkSize : CHUNK_FALLBACK;
  try {
    await pushFile({
      http,
      nodeId,
      uploadId,
      localPath,
      size,
      step,
      ranged: init.ranged === true,
      progress,
      signal,
    });
    await commitUpload({ http, nodeId, uploadId, size, progress, signal });
  } catch (error) {
    await http
      .fetch(nodeId, `/api/files/upload/${uploadId}`, { method: 'DELETE' })
      .catch(() => undefined);
    rethrowIfAborted(error, signal);
  }
}

async function pushFile(input: {
  http: HttpClient;
  nodeId: string;
  uploadId: string;
  localPath: string;
  size: number;
  step: number;
  ranged: boolean;
  progress: CopyProgress;
  signal?: AbortSignal;
}): Promise<void> {
  const { http, nodeId, uploadId, localPath, size, step, ranged, progress, signal } = input;
  const handle = await open(localPath, 'r');
  try {
    const tracker = new ProgressTracker({ totalBytes: size });
    const abort = signal ?? new AbortController().signal;
    const result = await runPush(
      uploadTransport({ http, nodeId, uploadId, handle, ranged, signal }),
      {
        totalBytes: size,
        streams: 1,
        maxRangeBytes: step,
        maxAttempts: UPLOAD_ATTEMPTS,
        deadlineMs: Date.now() + UPLOAD_DEADLINE_MS,
        signal: abort,
        sleep: jitteredSleep,
        onProgress: (transferred) => {
          tracker.set(transferred);
          progress.emit({
            type: 'progress',
            phase: 'upload',
            bytes: transferred,
            total: size,
            pct: pctOf(transferred, size),
            path: localPath,
          });
        },
      }
    );
    if (result.kind === 'cancelled') throw new InterruptError('upload cancelled');
    if (result.kind === 'failed') throw new CliError(`upload failed: ${result.error}`);
  } finally {
    await handle.close();
  }
}

function uploadTransport(input: {
  http: HttpClient;
  nodeId: string;
  uploadId: string;
  handle: Awaited<ReturnType<typeof open>>;
  ranged: boolean;
  signal?: AbortSignal;
}): PushTransport {
  const { http, nodeId, uploadId, handle, ranged, signal } = input;
  let asked = false;
  return {
    async status(attemptSignal) {
      if (!asked) {
        asked = true;
        return null;
      }
      try {
        const body = await filesJson<UploadStatus>(
          http,
          nodeId,
          'GET',
          `/api/files/upload/${uploadId}`,
          undefined,
          { signal: attemptSignal, timeoutMs: null }
        );
        return {
          receivedBytes: body.received ?? 0,
          ranges: ranged ? (body.ranges ?? []).map(([offset, length]) => ({ offset, length })) : [],
          complete: body.complete === true,
        };
      } catch {
        if (attemptSignal.aborted) return null;
        return null;
      }
    },
    async put(range, opts) {
      if (signal?.aborted || opts.signal.aborted) return { kind: 'cancelled' };
      const buf = Buffer.allocUnsafe(range.length);
      const { bytesRead } = await handle.read(buf, 0, range.length, range.offset);
      const chunk = buf.subarray(0, bytesRead);
      const query = `?offset=${range.offset}&length=${range.length}`;
      try {
        const response = await http.fetch(nodeId, `/api/files/upload/${uploadId}${query}`, {
          method: 'PUT',
          body: chunk,
          signal: opts.signal,
          timeoutMs: null,
        });
        if (response.ok) {
          await response.arrayBuffer().catch(() => undefined);
          opts.onProgress(chunk.byteLength);
          return { kind: 'landed' };
        }
        const text = await response.text().catch(() => '');
        return response.status === 409 || response.status >= 500
          ? { kind: 'retry', error: text || `HTTP ${response.status}` }
          : { kind: 'fail', error: text || `HTTP ${response.status}` };
      } catch (error) {
        if (signal?.aborted || opts.signal.aborted) return { kind: 'cancelled' };
        return { kind: 'retry', error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

async function commitUpload(input: {
  http: HttpClient;
  nodeId: string;
  uploadId: string;
  size: number;
  progress: CopyProgress;
  signal?: AbortSignal;
}): Promise<void> {
  const { http, nodeId, uploadId, size, progress, signal } = input;
  const response = await http.fetch(nodeId, `/api/files/upload/${uploadId}/commit`, {
    method: 'POST',
    signal,
    timeoutMs: null,
  });
  await assertFilesOk(nodeId, `/api/files/upload/${uploadId}/commit`, response);
  let done = false;
  await consumeNdjson<CommitEvent>(response, (event) => {
    if (event.type === 'progress') {
      progress.emit({
        type: 'progress',
        phase: 'commit',
        bytes: event.transferred ?? 0,
        total: size,
        pct: event.pct ?? pctOf(event.transferred ?? 0, size),
        rate: event.rate,
      });
    } else if (event.type === 'done') {
      done = true;
    } else if (event.type === 'error') {
      throw new CliError(event.detail ?? event.code ?? 'upload commit failed');
    }
  });
  if (!done) throw new CliError('upload commit did not finish');
}

export async function downloadRemoteFile(input: {
  http: HttpClient;
  nodeId: string;
  rootId: string;
  absPath: string;
  destPath: string;
  name: string;
  progress: CopyProgress;
  signal?: AbortSignal;
}): Promise<void> {
  const { http, nodeId, rootId, absPath, destPath, name, progress, signal } = input;
  let downloadId = '';
  try {
    const prepared = await prepareDownload({
      http,
      nodeId,
      rootId,
      absPath,
      name,
      progress,
      signal,
    });
    downloadId = prepared.downloadId;
    await drainContent({
      http,
      nodeId,
      downloadId,
      destPath,
      size: prepared.size,
      progress,
      signal,
    });
    await http
      .fetch(nodeId, `/api/files/download/${downloadId}`, { method: 'DELETE' })
      .catch(() => undefined);
  } catch (error) {
    if (downloadId) {
      await http
        .fetch(nodeId, `/api/files/download/${downloadId}`, { method: 'DELETE' })
        .catch(() => undefined);
    }
    rethrowIfAborted(error, signal);
  }
}

async function prepareDownload(input: {
  http: HttpClient;
  nodeId: string;
  rootId: string;
  absPath: string;
  name: string;
  progress: CopyProgress;
  signal?: AbortSignal;
}): Promise<{ downloadId: string; size: number; name: string }> {
  const { http, nodeId, rootId, absPath, name, progress, signal } = input;
  const response = await http.fetch(nodeId, '/api/files/download/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rootId, path: absPath }),
    signal,
    timeoutMs: null,
  });
  await assertFilesOk(nodeId, '/api/files/download/prepare', response);
  let downloadId = '';
  let size = 0;
  let fileName = name;
  let error: string | null = null;
  await consumeNdjson<PrepareEvent>(response, (event) => {
    if (event.type === 'progress') {
      progress.emit({
        type: 'progress',
        phase: 'download',
        bytes: event.transferred ?? 0,
        pct: event.pct ?? 0,
        rate: event.rate,
        path: absPath,
      });
    } else if (event.type === 'done') {
      downloadId = event.downloadId ?? '';
      size = event.size ?? 0;
      fileName = event.name ?? name;
    } else if (event.type === 'error') {
      error = event.detail ?? event.code ?? 'prepare failed';
    }
  });
  if (error) throw new CliError(error);
  if (!downloadId) throw new CliError('download prepare did not return an id');
  return { downloadId, size, name: fileName };
}

async function drainContent(input: {
  http: HttpClient;
  nodeId: string;
  downloadId: string;
  destPath: string;
  size: number;
  progress: CopyProgress;
  signal?: AbortSignal;
}): Promise<void> {
  const { http, nodeId, downloadId, destPath, size, progress, signal } = input;
  const handle = await open(destPath, 'w');
  let received = 0;
  let lastError: unknown = null;
  try {
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      try {
        received = await readContentOnce({
          http,
          nodeId,
          downloadId,
          handle,
          received,
          size,
          progress,
          signal,
        });
        if (size <= 0 || received >= size) return;
        lastError = new CliError(`download truncated: ${received}/${size}`);
      } catch (error) {
        throwIfAborted(signal);
        lastError = error;
      }
      if (attempt < DOWNLOAD_ATTEMPTS) {
        const abort = signal ?? new AbortController().signal;
        await jitteredSleep(DOWNLOAD_BACKOFF_MS[attempt - 1] ?? 1000, abort);
      }
    }
  } finally {
    await handle.close();
  }
  throw lastError instanceof Error ? lastError : new CliError('download failed');
}

async function readContentOnce(input: {
  http: HttpClient;
  nodeId: string;
  downloadId: string;
  handle: Awaited<ReturnType<typeof open>>;
  received: number;
  size: number;
  progress: CopyProgress;
  signal?: AbortSignal;
}): Promise<number> {
  const { http, nodeId, downloadId, handle, size, progress, signal } = input;
  let received = input.received;
  const headers: Record<string, string> = {};
  if (received > 0) headers.range = `bytes=${received}-`;
  const response = await http.fetch(nodeId, `/api/files/download/${downloadId}/content`, {
    headers,
    signal,
    timeoutMs: null,
  });
  await assertFilesOk(nodeId, `/api/files/download/${downloadId}/content`, response);
  if (received > 0 && response.status !== 206) {
    received = 0;
    await handle.truncate(0);
  }
  const total = size > 0 ? size : Number(response.headers.get('content-length') ?? '0');
  const body = response.body;
  if (!body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength) await handle.write(bytes, 0, bytes.byteLength, received);
    return received + bytes.byteLength;
  }
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    await handle.write(value, 0, value.byteLength, received);
    received += value.byteLength;
    progress.emit({
      type: 'progress',
      phase: 'download',
      bytes: received,
      total,
      pct: pctOf(received, total),
    });
  }
  return received;
}

export function rawFilePath(rootId: string, absPath: string): string {
  return filesQuery('raw', rootId, absPath);
}
