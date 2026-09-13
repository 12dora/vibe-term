// 发行资产下载的重定向与读流约束：探测和并行 Range 共用，避免两套策略漂移。
// 每一跳必须是 https；最终主机只能是起始 origin、GitHub 仓库主机，或 *.githubusercontent.com。

import { errorMessage } from '../errors';
import { isAllowedReleaseDownloadHost } from './source';

export const MAX_RELEASE_REDIRECTS = 5;
export const REDIRECT_REJECTED = 'redirect_rejected';
export const DEFAULT_READ_IDLE_MS = 60_000;

export type ReleaseRedirectFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export class RedirectRejectedError extends Error {
  readonly error = REDIRECT_REJECTED;
  constructor() {
    super(REDIRECT_REJECTED);
    this.name = 'RedirectRejectedError';
  }
}

export class MidDownloadRedirectError extends Error {
  constructor() {
    super('UnexpectedRedirect');
    this.name = 'MidDownloadRedirectError';
  }
}

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function isRedirectRejected(err: unknown): boolean {
  return err instanceof RedirectRejectedError || errorMessage(err) === REDIRECT_REJECTED;
}

export function isMidDownloadRedirect(err: unknown): boolean {
  if (err instanceof MidDownloadRedirectError) return true;
  return /unexpected\s*redirect/i.test(errorMessage(err));
}

export function releaseOriginHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw new RedirectRejectedError();
  }
}

export function resolveReleaseRedirect(
  current: string,
  location: string | null,
  originHost: string
): string {
  if (!location) throw new RedirectRejectedError();
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new RedirectRejectedError();
  }
  if (next.protocol !== 'https:') throw new RedirectRejectedError();
  if (!isAllowedReleaseDownloadHost(next.hostname, originHost)) {
    throw new RedirectRejectedError();
  }
  return next.href;
}

export async function followReleaseRedirects(
  url: string,
  fetchFn: ReleaseRedirectFetch,
  init: { headers?: HeadersInit; signal?: AbortSignal }
): Promise<{ url: string; res: Response }> {
  const originHost = releaseOriginHost(url);
  let current = url;
  let redirects = 0;
  for (;;) {
    throwIfAborted(init.signal);
    const res = await fetchFn(current, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      headers: init.headers,
      signal: init.signal,
    });
    if (!isRedirectStatus(res.status)) return { url: current, res };
    redirects += 1;
    if (redirects > MAX_RELEASE_REDIRECTS) {
      await res.body?.cancel().catch(() => {});
      throw new Error('too many redirects');
    }
    const next = resolveReleaseRedirect(current, res.headers.get('location'), originHost);
    await res.body?.cancel().catch(() => {});
    current = next;
  }
}

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

export async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: {
    signal?: AbortSignal;
    idleMs?: number;
    body?: ReadableStream<Uint8Array> | null;
  } = {}
): Promise<StreamReadResult> {
  if (opts.signal?.aborted) {
    await cancelStream(reader, opts.body);
    throw abortError();
  }
  const watch = Boolean(opts.signal) || (opts.idleMs != null && opts.idleMs > 0);
  if (!watch) return await reader.read();
  return await raceRead(reader, opts);
}

async function raceRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: {
    signal?: AbortSignal;
    idleMs?: number;
    body?: ReadableStream<Uint8Array> | null;
  }
): Promise<StreamReadResult> {
  const readPromise = reader.read();
  return await new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      action();
    };
    const fail = (err: Error): void => {
      void cancelStream(reader, opts.body);
      finish(() => reject(err));
    };
    const onAbort = (): void => fail(abortError());
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
    if (opts.idleMs != null && opts.idleMs > 0) {
      idleTimer = setTimeout(() => fail(new Error('read idle timeout')), opts.idleMs);
    }
    readPromise.then(
      (result) => finish(() => resolve(result)),
      (err) => finish(() => reject(err))
    );
  });
}

async function cancelStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  body?: ReadableStream<Uint8Array> | null
): Promise<void> {
  await reader.cancel().catch(() => {});
  await body?.cancel().catch(() => {});
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
