// 下载 leg2 的内容拉取：把 [0,size) 切成 8 MiB 区间，用 `streams` 条并行 Range GET 取回。
// 统一的重试策略（顺序流与分块请求共用）：区间的已收偏移越过此前最高点才清零失败计数，
// 连续 4 次没有新进展才放弃；每个区间从自己已收的偏移续传，已收字节不丢。
// 对端不认 Range（对 Range 请求回 200）时退回单条顺序流，仍按已收偏移用开放区间续传。

import type { ApiClient } from './client';
import { FileApiError, TransferInterruptedError, abortError, parseError } from './file-errors';

export const DOWNLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/** 连续无进展的重试退避（毫秒）。 */
export const DOWNLOAD_RETRY_BACKOFF_MS = [500, 1000, 2000, 4000] as const;
/** 连续这么多次请求一字节都没送达即放弃。 */
export const DOWNLOAD_MAX_EMPTY_ATTEMPTS = 4;

export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

export interface ContentFetchInput {
  client: ApiClient;
  downloadId: string;
  size: number;
  streams: number;
  signal?: AbortSignal;
  chunkBytes?: number;
  sleep?: SleepFn;
  /** 所有区间累计已收字节（精确值）。 */
  onProgress: (received: number) => void;
}

interface Segment {
  start: number;
  length: number;
  parts: Uint8Array[];
  received: number;
}

interface Ctx {
  client: ApiClient;
  url: string;
  size: number;
  signal: AbortSignal;
  sleep: SleepFn;
  onProgress: (received: number) => void;
  received: number;
  etag: string | null;
  /** 已从第一个成功响应里取过校验器。 */
  probed: boolean;
}

/** 分块模式下对端对 Range 请求回了整份 200，或给了对不上号的 206。 */
class RangesUnsupported extends Error {}

/** 顺序流的续传请求拿到了对不上号的 Content-Range；按可重试失败处理，耗尽后作为中断原因。 */
class ContentRangeError extends Error {
  constructor(header: string | null) {
    super(`unexpected content range: ${header ?? 'missing'}`);
    this.name = 'ContentRangeError';
  }
}

type Mode = 'chunk' | 'whole';
/** 一次请求的结局：`error === null` 表示该区间已收齐。 */
type Attempt = { error: unknown };

const defaultSleep: SleepFn = (ms, signal) =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

function sourceChanged(): FileApiError {
  return new FileApiError(400, 'source changed', 'invalid', 'source changed');
}

function isPermanentStatus(status: number): boolean {
  return status < 500 && status !== 408 && status !== 429;
}

/** 弱校验器不能用于 If-Range。 */
function strongEtag(value: string | null): string | null {
  return value && !value.startsWith('W/') ? value : null;
}

function credit(ctx: Ctx, delta: number): void {
  ctx.received += delta;
  ctx.onProgress(ctx.received);
}

function splitSegments(size: number, chunk: number): Segment[] {
  const out: Segment[] = [];
  for (let start = 0; start < size; start += chunk) {
    out.push({ start, length: Math.min(chunk, size - start), parts: [], received: 0 });
  }
  return out;
}

function requestHeaders(ctx: Ctx, seg: Segment, mode: Mode): Record<string, string> | undefined {
  const from = seg.start + seg.received;
  if (mode === 'whole' && from === 0) return undefined;
  const last = seg.start + seg.length - 1;
  const headers: Record<string, string> = {
    Range: mode === 'whole' ? `bytes=${from}-` : `bytes=${from}-${last}`,
  };
  if (ctx.etag) headers['If-Range'] = ctx.etag;
  return headers;
}

/** 代理可能把区间截短；只要从请求的偏移开始、不越界、总长一致就收下，剩余部分由续传补齐。 */
function contentRangeOk(header: string | null, from: number, last: number, size: number): boolean {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header ?? '');
  if (!m) return false;
  const [start, end] = [Number(m[1]), Number(m[2])];
  return start === from && end <= last && (m[3] === '*' || Number(m[3]) === size);
}

function resetSegment(ctx: Ctx, seg: Segment): void {
  const dropped = seg.received;
  seg.parts = [];
  seg.received = 0;
  if (dropped > 0) credit(ctx, -dropped);
}

/** 对 Range 请求回了 200：校验器变了说明源文件换了；没变就是对端不认 Range。 */
function handleFullResponse(ctx: Ctx, seg: Segment, mode: Mode, res: Response): void {
  const etag = res.headers.get('ETag');
  if (ctx.etag && etag !== ctx.etag) throw sourceChanged();
  if (mode === 'chunk') throw new RangesUnsupported();
  resetSegment(ctx, seg);
}

/** 206 对得上号返回 null；对不上：分块模式退回顺序流，顺序流里按可重试失败交回。 */
function checkPartial(
  ctx: Ctx,
  seg: Segment,
  mode: Mode,
  headers: Record<string, string> | undefined,
  res: Response
): unknown {
  const from = seg.start + seg.received;
  const last = mode === 'whole' ? ctx.size - 1 : seg.start + seg.length - 1;
  const header = res.headers.get('Content-Range');
  if (headers && contentRangeOk(header, from, last, ctx.size)) return null;
  if (mode === 'chunk') throw new RangesUnsupported();
  return new ContentRangeError(header);
}

/**
 * 判定响应能不能用。永久性错误直接抛；可重试的失败原因作为返回值交回；
 * 返回 null 表示响应体可以读了。
 */
async function judgeResponse(
  ctx: Ctx,
  seg: Segment,
  mode: Mode,
  headers: Record<string, string> | undefined,
  res: Response
): Promise<unknown> {
  if (!res.ok) {
    const error = await parseError(res);
    if (isPermanentStatus(res.status)) throw error;
    return error;
  }
  if (res.status === 206) {
    const mismatch = checkPartial(ctx, seg, mode, headers, res);
    if (mismatch) return mismatch;
  } else if (res.status !== 200) throw await parseError(res);
  else if (headers) handleFullResponse(ctx, seg, mode, res);
  if (!ctx.probed) {
    ctx.probed = true;
    ctx.etag = strongEtag(res.headers.get('ETag'));
  }
  return res.body || seg.length === 0 ? null : new Error('empty response body');
}

/** 收下一段字节；对端多给的部分丢弃，区间不会被撑破。 */
function keep(ctx: Ctx, seg: Segment, value: Uint8Array): void {
  const take = Math.min(value.byteLength, seg.length - seg.received);
  seg.parts.push(take === value.byteLength ? value : value.subarray(0, take));
  seg.received += take;
  credit(ctx, take);
}

async function readBody(
  ctx: Ctx,
  seg: Segment,
  body: ReadableStream<Uint8Array>
): Promise<Attempt> {
  const reader = body.getReader();
  const stop = (): void => void reader.cancel().catch(() => {});
  ctx.signal.addEventListener('abort', stop, { once: true });
  try {
    while (seg.received < seg.length) {
      const { done, value } = await reader.read();
      if (ctx.signal.aborted) throw abortError();
      if (done) break;
      if (!value?.byteLength) continue;
      keep(ctx, seg, value);
    }
    if (seg.received >= seg.length) stop();
    return { error: seg.received >= seg.length ? null : new Error('body ended early') };
  } catch (err) {
    if (ctx.signal.aborted) throw abortError();
    return { error: err };
  } finally {
    ctx.signal.removeEventListener('abort', stop);
  }
}

async function attemptSegment(ctx: Ctx, seg: Segment, mode: Mode): Promise<Attempt> {
  if (ctx.signal.aborted) throw abortError();
  const headers = requestHeaders(ctx, seg, mode);
  let res: Response;
  try {
    res = await ctx.client.fetch(ctx.url, {
      headers,
      signal: ctx.signal,
      timeout: false,
      purpose: 'transfer',
    });
  } catch (err) {
    if (ctx.signal.aborted) throw abortError();
    return { error: err };
  }
  let problem: unknown;
  try {
    problem = await judgeResponse(ctx, seg, mode, headers, res);
  } catch (err) {
    void res.body?.cancel().catch(() => {});
    throw err;
  }
  if (problem) {
    void res.body?.cancel().catch(() => {});
    return { error: problem };
  }
  if (seg.length === 0) {
    void res.body?.cancel().catch(() => {});
    return { error: null };
  }
  return readBody(ctx, seg, res.body as ReadableStream<Uint8Array>);
}

function giveUp(ctx: Ctx, error: unknown): Error {
  // 服务端给过明确原因就原样上抛；纯链路问题才算「传输中断」
  return error instanceof FileApiError
    ? error
    : new TransferInterruptedError(ctx.received, ctx.size, error);
}

async function fetchSegment(ctx: Ctx, seg: Segment, mode: Mode): Promise<void> {
  let empty = 0;
  // 只有收到的偏移越过该区间此前的最高点才算「有进展」：顺序流被整份重来后
  // 每次都在同一偏移断掉，不能因此永远清零计数、无退避地空转。
  let best = seg.received;
  for (;;) {
    const { error } = await attemptSegment(ctx, seg, mode);
    if (error === null) return;
    if (seg.received > best) {
      best = seg.received;
      empty = 0;
      continue;
    }
    empty += 1;
    if (empty >= DOWNLOAD_MAX_EMPTY_ATTEMPTS) throw giveUp(ctx, error);
    await ctx.sleep(DOWNLOAD_RETRY_BACKOFF_MS[empty - 1] ?? 4000, ctx.signal);
  }
}

/** 工作池：任一区间失败即中止其余在飞请求，只上抛第一个失败（根因），不让随后的 AbortError 盖掉它。 */
async function runPool(
  ctx: Ctx,
  abort: () => void,
  segs: readonly Segment[],
  lanes: number
): Promise<void> {
  let cursor = 0;
  const state: { failure?: { error: unknown } } = {};
  const lane = async (): Promise<void> => {
    while (!state.failure) {
      const seg = segs[cursor];
      cursor += 1;
      if (!seg) return;
      try {
        await fetchSegment(ctx, seg, 'chunk');
      } catch (error) {
        state.failure ??= { error };
        abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, segs.length) }, lane));
  if (state.failure) throw state.failure.error;
}

function assemble(segs: readonly Segment[]): Blob {
  return new Blob(segs.flatMap((s) => s.parts) as BlobPart[]);
}

async function fetchChunked(
  ctx: Ctx,
  abort: () => void,
  streams: number,
  chunk: number
): Promise<Blob> {
  const segs = splitSegments(ctx.size, chunk);
  // 第一个区间单独先取：拿到校验器后其余区间才带 If-Range 并行，对端不认 Range 也只浪费一个请求。
  await fetchSegment(ctx, segs[0] as Segment, 'chunk');
  await runPool(ctx, abort, segs.slice(1), streams);
  return assemble(segs);
}

async function fetchWhole(ctx: Ctx): Promise<Blob> {
  const seg: Segment = { start: 0, length: ctx.size, parts: [], received: 0 };
  await fetchSegment(ctx, seg, 'whole');
  return assemble([seg]);
}

async function inPhase<T>(
  input: ContentFetchInput,
  run: (ctx: Ctx, abort: () => void) => Promise<T>
): Promise<T> {
  if (input.signal?.aborted) throw abortError();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  const ctx: Ctx = {
    client: input.client,
    url: `/api/files/download/${input.downloadId}/content`,
    size: input.size,
    signal: controller.signal,
    sleep: input.sleep ?? defaultSleep,
    onProgress: input.onProgress,
    received: 0,
    etag: null,
    probed: false,
  };
  try {
    return await run(ctx, abort);
  } finally {
    abort();
    input.signal?.removeEventListener('abort', abort);
  }
}

export async function fetchContentBlob(input: ContentFetchInput): Promise<Blob> {
  const chunk = input.chunkBytes ?? DOWNLOAD_CHUNK_BYTES;
  const parallel = input.streams > 1 && input.size > chunk;
  if (parallel) {
    try {
      return await inPhase(input, (ctx, abort) => fetchChunked(ctx, abort, input.streams, chunk));
    } catch (err) {
      if (!(err instanceof RangesUnsupported)) throw err;
      input.onProgress(0);
    }
  }
  return inPhase(input, fetchWhole);
}
