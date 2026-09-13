// GitHub Release 资产的速度探测契约：先解析 302 到最终 CDN 地址，再用一小段 Range 读判定
// 「快 / 慢 / 不可达」。投递策略（节点自拉 vs 入口推包）与并行下载都依赖这一份判定，
// 实现放在同文件（WPU1 补全），调用方只依赖本签名。

import { combineAbortSignals } from '../async/abort';
import { errorMessage } from '../errors';
import { followReleaseRedirects, readStreamChunk } from './redirect';

export type ReleaseSpeedVerdict = 'fast' | 'slow' | 'unreachable';

export interface ReleaseSpeedProbeOptions {
  /** 整次探测的墙钟上限（默认 3000 ms）。 */
  deadlineMs?: number;
  /** 期限内至少要收到的字节数才算 `fast`（默认 64 KiB）。 */
  minBytes?: number;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  signal?: AbortSignal;
  headers?: HeadersInit;
}

export interface ReleaseSpeedProbeResult {
  verdict: ReleaseSpeedVerdict;
  /** 302 跟随后的最终资产地址；不可达时为 null。 */
  finalUrl: string | null;
  /** 期限内收到的字节数。 */
  bytes: number;
  elapsedMs: number;
  /** 最终地址是否接受 `Range`（206）。并行下载据此决定单流还是多流。 */
  acceptsRanges: boolean;
  /** `Content-Length`（若已知）。 */
  totalBytes: number | null;
  error?: string;
}

const DEFAULT_DEADLINE_MS = 3000;
const DEFAULT_MIN_BYTES = 64 * 1024;

export async function probeReleaseAssetSpeed(
  url: string,
  opts: ReleaseSpeedProbeOptions = {}
): Promise<ReleaseSpeedProbeResult> {
  const started = (opts.now ?? Date.now)();
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const minBytes = Math.max(1, opts.minBytes ?? DEFAULT_MIN_BYTES);
  const elapsed = (): number => Math.max(0, (opts.now ?? Date.now)() - started);
  const finish = (
    partial: Omit<ReleaseSpeedProbeResult, 'elapsedMs'>
  ): ReleaseSpeedProbeResult => ({ ...partial, elapsedMs: elapsed() });

  throwIfUserAborted(opts.signal);

  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = combineAbortSignals(deadline, opts.signal) ?? deadline;
  const fetchFn = opts.fetch ?? fetch;

  try {
    return finish(
      await probeWithRedirects(url, {
        fetchFn,
        signal,
        userSignal: opts.signal,
        deadline,
        minBytes,
        headers: opts.headers,
      })
    );
  } catch (err) {
    throwIfUserAborted(opts.signal);
    if (isAbortError(err)) {
      return finish(unreachable(deadline.aborted ? 'timeout' : errorMessage(err)));
    }
    return finish(unreachable(errorMessage(err)));
  }
}

type ProbeRun = {
  fetchFn: NonNullable<ReleaseSpeedProbeOptions['fetch']>;
  signal: AbortSignal;
  userSignal?: AbortSignal;
  deadline: AbortSignal;
  minBytes: number;
  headers?: HeadersInit;
};

async function probeWithRedirects(
  url: string,
  run: ProbeRun
): Promise<Omit<ReleaseSpeedProbeResult, 'elapsedMs'>> {
  const headers = new Headers(run.headers);
  headers.set('Range', `bytes=0-${run.minBytes - 1}`);
  const opened = await followReleaseRedirects(url, run.fetchFn, {
    headers,
    signal: run.signal,
  });
  return await classifyProbeResponse(opened.res, opened.url, run);
}

async function classifyProbeResponse(
  res: Response,
  url: string,
  run: ProbeRun
): Promise<Omit<ReleaseSpeedProbeResult, 'elapsedMs'>> {
  if (res.status >= 400) {
    const status = res.status;
    await cancelBody(res);
    return unreachable(`HTTP ${status}`);
  }
  if (res.status !== 200 && res.status !== 206) {
    await cancelBody(res);
    return unreachable(`HTTP ${res.status}`);
  }

  const acceptsRanges = res.status === 206 || acceptsBytesRanges(res.headers);
  const totalBytes = parseTotalBytes(res, acceptsRanges);
  const read = await readProbeBody(res, run.minBytes, run);
  throwIfUserAborted(run.userSignal);

  const wholeAsset =
    read.completed &&
    (totalBytes == null || totalBytes <= run.minBytes || read.bytes >= totalBytes);
  const fast = read.bytes >= run.minBytes || wholeAsset;
  return {
    verdict: fast ? 'fast' : 'slow',
    finalUrl: url,
    bytes: read.bytes,
    acceptsRanges,
    totalBytes,
  };
}

async function readProbeBody(
  res: Response,
  minBytes: number,
  run: ProbeRun
): Promise<{ bytes: number; completed: boolean }> {
  if (!res.body) return { bytes: 0, completed: true };
  const reader = res.body.getReader();
  let bytes = 0;
  try {
    while (bytes < minBytes) {
      throwIfUserAborted(run.userSignal);
      const { done, value } = await readStreamChunk(reader, {
        signal: run.signal,
        body: res.body,
      });
      if (done) return { bytes, completed: true };
      bytes += value.byteLength;
    }
    return { bytes, completed: false };
  } catch (err) {
    throwIfUserAborted(run.userSignal);
    if (isAbortError(err) || run.deadline.aborted) {
      return { bytes, completed: false };
    }
    throw err;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function parseTotalBytes(res: Response, acceptsRanges: boolean): number | null {
  if (res.status === 206 || acceptsRanges) {
    const ranged = parseContentRangeTotal(res.headers.get('content-range'));
    if (ranged != null) return ranged;
  }
  if (res.status === 200) return parsePositiveInt(res.headers.get('content-length'));
  return null;
}

function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const matched = /bytes\s+\d+-\d+\/(\d+)/i.exec(header.trim());
  return matched ? parsePositiveInt(matched[1] ?? null) : null;
}

function parsePositiveInt(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function acceptsBytesRanges(headers: Headers): boolean {
  return (headers.get('accept-ranges') ?? '').trim().toLowerCase() === 'bytes';
}

function unreachable(error: string): Omit<ReleaseSpeedProbeResult, 'elapsedMs'> {
  return {
    verdict: 'unreachable',
    finalUrl: null,
    bytes: 0,
    acceptsRanges: false,
    totalBytes: null,
    error,
  };
}

async function cancelBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function throwIfUserAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortError();
}

function abortError(): Error {
  const err = new Error('UPGRADE_CANCELLED');
  err.name = 'AbortError';
  return err;
}
