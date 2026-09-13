// 发行资产的并行 Range 下载：把分片写进预分配的 `.part`，整包 sha256 只在落盘后顺序扫一遍。
// Node-only（fs.promises）；不要从浏览器 barrel 再导出。
//
// 未预知 Accept-Ranges 时，第一次 GET 带 Range 兼做探测：206 则并行其余分片，
// 200 则把这一次响应当单流写完（避免再打一枪把调用方的挂起流/计数测例冲掉）。

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { combineAbortSignals } from '../async/abort';
import { sleepOrAbort } from '../async/sleep';
import { errorMessage } from '../errors';
import type { ReleaseSpeedVerdict } from './speed-probe';

export type ReleaseAssetFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type RangedDownloadProgress = (downloadedBytes: number, totalBytes: number) => void;

export type DownloadAssetRangedOptions = {
  destPath: string;
  totalBytes: number | null;
  streams?: number;
  chunkBytes?: number;
  onProgress?: RangedDownloadProgress;
  fetch?: ReleaseAssetFetch;
  signal?: AbortSignal;
  retriesPerChunk?: number;
  acceptsRanges?: boolean;
  headers?: HeadersInit;
};

export type DownloadedAsset = {
  bytes: number;
  sha256: string;
  streams: number;
  /** 进度分母：未知总量时为 0。 */
  totalBytes: number;
  finalUrl: string;
  verdict: ReleaseSpeedVerdict;
};

const DEFAULT_STREAMS = 4;
const MAX_STREAMS = 8;
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETRIES = 3;
const RETRY_BASE_MS = 100;
const MAX_REDIRECTS = 5;
const SPEED_DEADLINE_MS = 3000;
const SPEED_MIN_BYTES = 64 * 1024;

export async function downloadAssetRanged(
  url: string,
  opts: DownloadAssetRangedOptions
): Promise<DownloadedAsset> {
  throwIfAborted(opts.signal);
  const fetchFn = opts.fetch ?? fetch;
  const chunkBytes = Math.max(1, opts.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  const retries = Math.max(0, opts.retriesPerChunk ?? DEFAULT_RETRIES);
  const ctx: DownloadCtx = {
    destPath: opts.destPath,
    fetchFn,
    signal: opts.signal,
    onProgress: opts.onProgress,
    headers: opts.headers,
    chunkBytes,
    retries,
    streamsWanted: opts.streams,
  };

  if (opts.acceptsRanges === true && opts.totalBytes != null && opts.totalBytes > chunkBytes) {
    const streams = clampStreams(opts.streams, Math.ceil(opts.totalBytes / chunkBytes));
    const speed = createSpeedWatch();
    await downloadParallel(url, {
      ...ctx,
      totalBytes: opts.totalBytes,
      streams,
      skipUntil: 0,
      speed,
    });
    const hashed = await sha256File(opts.destPath);
    return {
      ...hashed,
      streams,
      totalBytes: opts.totalBytes,
      finalUrl: url,
      verdict: speed.verdict(hashed.bytes),
    };
  }

  return await downloadDiscovering(url, ctx);
}

type DownloadCtx = {
  destPath: string;
  fetchFn: ReleaseAssetFetch;
  signal?: AbortSignal;
  onProgress?: RangedDownloadProgress;
  headers?: HeadersInit;
  chunkBytes: number;
  retries: number;
  streamsWanted?: number;
};

async function downloadDiscovering(url: string, ctx: DownloadCtx): Promise<DownloadedAsset> {
  const opened = await openFollowingRedirects(url, ctx);
  if (opened.res.status >= 400) {
    const status = opened.res.status;
    await opened.res.body?.cancel().catch(() => {});
    throw new Error(`GitHub release tarball HTTP ${status}`);
  }
  if (opened.res.status === 206) {
    return await downloadFromRangeStart(opened, ctx);
  }
  return await drainResponseToFile(opened, ctx);
}

async function openFollowingRedirects(
  url: string,
  ctx: DownloadCtx
): Promise<{ url: string; res: Response }> {
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    throwIfAborted(ctx.signal);
    const headers = new Headers(ctx.headers);
    headers.set('Range', `bytes=0-${ctx.chunkBytes - 1}`);
    const res = await ctx.fetchFn(current, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      headers,
      signal: ctx.signal,
    });
    if (!isRedirectStatus(res.status)) return { url: current, res };
    const next = resolveLocation(current, res.headers.get('location'));
    await res.body?.cancel().catch(() => {});
    if (!next) throw new Error('GitHub release tarball redirect without Location');
    current = next;
  }
  throw new Error('GitHub release tarball too many redirects');
}

async function downloadFromRangeStart(
  opened: { url: string; res: Response },
  ctx: DownloadCtx
): Promise<DownloadedAsset> {
  const speed = createSpeedWatch();
  const ranged = parseContentRange(opened.res.headers.get('content-range'));
  const total = ranged?.total ?? null;
  const expected = ranged ? ranged.end - ranged.start + 1 : ctx.chunkBytes;
  const first = await readExact(opened.res, expected, ctx.signal);
  if (
    first.byteLength === 0 ||
    (total != null && first.byteLength < expected && first.byteLength < total)
  ) {
    throw new Error('GitHub release tarball incomplete first range');
  }
  speed.note(first.byteLength);

  if (total == null || total <= first.byteLength) {
    const fh = await open(ctx.destPath, 'w', 0o600);
    try {
      await writeAll(fh, first, 0);
      await fh.sync();
    } finally {
      await fh.close().catch(() => {});
    }
    ctx.onProgress?.(first.byteLength, total ?? first.byteLength);
    const hashed = await sha256File(ctx.destPath);
    return {
      ...hashed,
      streams: 1,
      totalBytes: total ?? hashed.bytes,
      finalUrl: opened.url,
      verdict: speed.verdict(hashed.bytes),
    };
  }

  const streams = clampStreams(ctx.streamsWanted, Math.ceil(total / ctx.chunkBytes));
  await downloadParallel(opened.url, {
    ...ctx,
    totalBytes: total,
    streams,
    skipUntil: first.byteLength,
    prefix: first,
    speed,
  });
  const hashed = await sha256File(ctx.destPath);
  return {
    ...hashed,
    streams,
    totalBytes: total,
    finalUrl: opened.url,
    verdict: speed.verdict(hashed.bytes),
  };
}

async function drainResponseToFile(
  opened: { url: string; res: Response },
  ctx: DownloadCtx
): Promise<DownloadedAsset> {
  if (!opened.res.ok && opened.res.status !== 200) {
    await opened.res.body?.cancel().catch(() => {});
    throw new Error(`GitHub release tarball HTTP ${opened.res.status}`);
  }
  const speed = createSpeedWatch();
  const total = parsePositiveInt(opened.res.headers.get('content-length')) ?? 0;
  const fh = await open(ctx.destPath, 'w', 0o600);
  let offset = 0;
  try {
    if (!opened.res.body) {
      await fh.sync();
      ctx.onProgress?.(0, total);
    } else {
      const reader = opened.res.body.getReader();
      try {
        for (;;) {
          throwIfAborted(ctx.signal);
          const { done, value } = await reader.read();
          if (done) break;
          await writeAll(fh, value, offset);
          offset += value.byteLength;
          speed.note(offset);
          ctx.onProgress?.(offset, total);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      await fh.sync();
    }
  } finally {
    await fh.close().catch(() => {});
  }
  const hashed = await sha256File(ctx.destPath);
  return {
    ...hashed,
    streams: 1,
    totalBytes: total,
    finalUrl: opened.url,
    verdict: speed.verdict(hashed.bytes),
  };
}

type ParallelOpts = DownloadCtx & {
  totalBytes: number;
  streams: number;
  skipUntil: number;
  prefix?: Buffer;
  speed: SpeedWatch;
};

async function downloadParallel(url: string, opts: ParallelOpts): Promise<void> {
  const chunks = planChunks(opts.totalBytes, opts.chunkBytes).filter(
    (chunk) => chunk.start >= opts.skipUntil
  );
  const fh = await open(opts.destPath, 'w', 0o600);
  const fail = new AbortController();
  const signal = combineAbortSignals(opts.signal, fail.signal) ?? fail.signal;
  let downloaded = opts.skipUntil;
  let writeChain = Promise.resolve();
  const writeAt = (buf: Uint8Array, position: number): Promise<void> => {
    const done = writeChain.then(() => writeAll(fh, buf, position));
    writeChain = done.then(
      () => undefined,
      () => undefined
    );
    return done;
  };
  try {
    await fh.truncate(opts.totalBytes);
    if (opts.prefix && opts.prefix.byteLength > 0) {
      await writeAt(opts.prefix, 0);
      opts.onProgress?.(downloaded, opts.totalBytes);
    }
    const workers = Math.min(opts.streams, Math.max(1, chunks.length));
    await runPool(chunks, workers, async (chunk) => {
      const buf = await fetchRangeWithRetry(url, chunk, {
        fetchFn: opts.fetchFn,
        signal,
        retries: opts.retries,
        headers: opts.headers,
      });
      await writeAt(buf, chunk.start);
      downloaded += buf.byteLength;
      opts.speed.note(downloaded);
      opts.onProgress?.(downloaded, opts.totalBytes);
    });
    await fh.sync();
  } catch (err) {
    fail.abort();
    throw err;
  } finally {
    await fh.close().catch(() => {});
  }
}

type ByteRange = { start: number; endInclusive: number };

function planChunks(totalBytes: number, chunkBytes: number): ByteRange[] {
  const chunks: ByteRange[] = [];
  for (let start = 0; start < totalBytes; start += chunkBytes) {
    chunks.push({ start, endInclusive: Math.min(start + chunkBytes, totalBytes) - 1 });
  }
  return chunks;
}

async function fetchRangeWithRetry(
  url: string,
  chunk: ByteRange,
  opts: {
    fetchFn: ReleaseAssetFetch;
    signal?: AbortSignal;
    retries: number;
    headers?: HeadersInit;
  }
): Promise<Buffer> {
  let last: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
    throwIfAborted(opts.signal);
    try {
      return await fetchRange(url, chunk, opts.fetchFn, opts.signal, opts.headers);
    } catch (err) {
      last = err;
      if (isAbortError(err)) throw err;
      if (attempt === opts.retries) break;
      const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, 2000);
      const slept = await sleepOrAbort(delay, opts.signal);
      if (!slept) throw abortError();
    }
  }
  throw last instanceof Error ? last : new Error(errorMessage(last));
}

async function fetchRange(
  url: string,
  chunk: ByteRange,
  fetchFn: ReleaseAssetFetch,
  signal?: AbortSignal,
  extraHeaders?: HeadersInit
): Promise<Buffer> {
  const headers = new Headers(extraHeaders);
  headers.set('Range', `bytes=${chunk.start}-${chunk.endInclusive}`);
  const res = await fetchFn(url, {
    cache: 'no-store',
    redirect: 'follow',
    signal,
    headers,
  });
  const expected = chunk.endInclusive - chunk.start + 1;
  if (res.status !== 206 && res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`GitHub release tarball HTTP ${res.status}`);
  }
  if (res.status === 200 && chunk.start !== 0) {
    await res.body?.cancel().catch(() => {});
    throw new Error('range request returned 200');
  }
  const buf = await readExact(res, expected, signal);
  if (buf.byteLength !== expected) {
    throw new Error(
      `incomplete range bytes=${chunk.start}-${chunk.endInclusive} got=${buf.byteLength}`
    );
  }
  return buf;
}

async function readExact(res: Response, expected: number, signal?: AbortSignal): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  try {
    while (got < expected) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, expected - got);
      parts.push(take === value.byteLength ? value : value.subarray(0, take));
      got += take;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts, got);
}

async function writeAll(fh: FileHandle, data: Uint8Array, position: number): Promise<void> {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let written = 0;
  while (written < buf.byteLength) {
    const result = await fh.write(buf, written, buf.byteLength - written, position + written);
    if (result.bytesWritten <= 0) throw new Error('short file write');
    written += result.bytesWritten;
  }
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  let firstError: unknown;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      if (firstError) return;
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      try {
        await worker(item);
      } catch (err) {
        firstError = err;
        throw err;
      }
    }
  });
  const settled = await Promise.allSettled(runners);
  if (firstError) throw firstError;
  const rejected = settled.find((item) => item.status === 'rejected');
  if (rejected && rejected.status === 'rejected') throw rejected.reason;
}

async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = createReadStream(path);
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      hash.update(buf);
      bytes += buf.byteLength;
    }
  } catch (err) {
    stream.destroy();
    throw err;
  }
  return { sha256: hash.digest('hex'), bytes };
}

export function logReleaseDownload(info: {
  url: string;
  streams: number;
  bytes: number;
  elapsedMs: number;
  verdict: ReleaseSpeedVerdict;
}): void {
  let host = info.url;
  try {
    host = new URL(info.url).host;
  } catch {
    // 非 URL 时原样打
  }
  console.log(
    `[upgrade] download url=${host} streams=${info.streams} bytes=${info.bytes} ms=${info.elapsedMs} verdict=${info.verdict}`
  );
}

type SpeedWatch = {
  note: (bytes: number) => void;
  verdict: (completedBytes: number) => ReleaseSpeedVerdict;
};

function createSpeedWatch(): SpeedWatch {
  const started = Date.now();
  let fast = false;
  return {
    note(bytes) {
      if (bytes >= SPEED_MIN_BYTES && Date.now() - started <= SPEED_DEADLINE_MS) fast = true;
    },
    verdict(completedBytes) {
      if (fast) return 'fast';
      if (completedBytes < SPEED_MIN_BYTES) return 'fast';
      return 'slow';
    },
  };
}

function clampStreams(requested: number | undefined, chunkCount: number): number {
  const wanted = requested ?? DEFAULT_STREAMS;
  return Math.max(1, Math.min(MAX_STREAMS, Math.floor(wanted), chunkCount));
}

function parseContentRange(
  header: string | null
): { start: number; end: number; total: number } | null {
  if (!header) return null;
  const matched = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(header.trim());
  if (!matched) return null;
  const start = Number(matched[1]);
  const end = Number(matched[2]);
  const total = Number(matched[3]);
  if (
    ![start, end, total].every((n) => Number.isFinite(n) && n >= 0) ||
    end < start ||
    total <= 0
  ) {
    return null;
  }
  return { start, end, total };
}

function parsePositiveInt(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function resolveLocation(current: string, location: string | null): string | null {
  if (!location) return null;
  try {
    return new URL(location, current).href;
  } catch {
    return null;
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortError();
}

function abortError(): Error {
  const err = new Error('UPGRADE_CANCELLED');
  err.name = 'AbortError';
  return err;
}
