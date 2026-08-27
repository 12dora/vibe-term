import { type FetchImpl, getUpdates } from './api';
import {
  type GetUpdatesResp,
  SESSION_EXPIRED_ERRCODE,
  type WeixinCredentials,
  type WeixinInboundMessage,
  type WeixinMessage,
} from './types';

export class WeixinSessionExpiredError extends Error {
  constructor() {
    super('iLink bot session expired; re-login required.');
    this.name = 'WeixinSessionExpiredError';
  }
}

export class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const DEFAULT_LONGPOLL_TIMEOUT_MS = 60_000;
const LONGPOLL_TIMEOUT_MARGIN_MS = 10_000;

export interface RunUpdateLoopOpts {
  credentials: WeixinCredentials;
  signal: AbortSignal;
  fetchImpl?: FetchImpl;
  loadCursor?: () => string | undefined | Promise<string | undefined>;
  saveCursor?: (buf: string) => void | Promise<void>;
  onMessage?: (msg: WeixinInboundMessage) => void | Promise<void>;
  onContextToken?: (userId: string, token: string) => void;
  toInbound: (msg: WeixinMessage) => WeixinInboundMessage;
  onSessionExpired?: () => void;
  onError?: (err: unknown) => void;
  longpollTimeoutMs?: number;
}

type PollOutcome =
  | { kind: 'aborted' }
  | { kind: 'retry' }
  | { kind: 'ok'; resp: GetUpdatesResp; longpollTimeoutMs?: number };

/** 指数退避封顶：2s,4s,8s,16s,30s(封顶)…失败计数仅在收到有效响应后复位。 */
export function computeBackoffMs(failures: number): number {
  return Math.min(RETRY_DELAY_MS * 2 ** Math.max(0, failures - 1), BACKOFF_DELAY_MS);
}

export function isSessionExpired(resp: GetUpdatesResp): boolean {
  return resp.ret === SESSION_EXPIRED_ERRCODE || resp.errcode === SESSION_EXPIRED_ERRCODE;
}

export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err instanceof AbortError) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runUpdateLoop(opts: RunUpdateLoopOpts): Promise<void> {
  let cursor = (await opts.loadCursor?.()) ?? '';
  let failures = 0;
  let longpollTimeoutMs = opts.longpollTimeoutMs ?? DEFAULT_LONGPOLL_TIMEOUT_MS;

  while (!opts.signal.aborted) {
    const outcome = await pollOnce(opts, cursor, longpollTimeoutMs);
    if (outcome.kind === 'aborted') return;
    if (outcome.kind === 'retry') {
      failures += 1;
      await backoffSleep(failures, opts.signal);
      continue;
    }
    failures = 0;
    if (outcome.longpollTimeoutMs != null) {
      longpollTimeoutMs = outcome.longpollTimeoutMs;
    }
    cursor = await applySuccessfulPoll(outcome.resp, opts, cursor);
  }
}

async function pollOnce(
  opts: RunUpdateLoopOpts,
  cursor: string,
  longpollTimeoutMs: number
): Promise<PollOutcome> {
  let resp: GetUpdatesResp;
  try {
    resp = await fetchUpdates(opts, cursor, longpollTimeoutMs);
  } catch (err) {
    if (opts.signal.aborted) return { kind: 'aborted' };
    opts.onError?.(err);
    return { kind: 'retry' };
  }

  handleSessionExpiry(resp, opts.onSessionExpired);

  if (typeof resp.ret === 'number' && resp.ret !== 0) {
    opts.onError?.(new Error(`getupdates ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`));
    return { kind: 'retry' };
  }

  return { kind: 'ok', resp, longpollTimeoutMs: nextLongpollTimeoutMs(resp) };
}

async function fetchUpdates(
  opts: RunUpdateLoopOpts,
  cursor: string,
  longpollTimeoutMs: number
): Promise<GetUpdatesResp> {
  // per-request 超时 = 服务端长轮询窗口 + margin（首请求用默认 60s）。
  // 超时只 abort 本次请求、不 abort 收信循环的 stop signal，故落入 catch 走 backoff，
  // 避免半开 / 黑洞连接让 await getUpdates 永久挂起。
  const perRequestSignal = AbortSignal.any([opts.signal, AbortSignal.timeout(longpollTimeoutMs)]);
  return getUpdates({
    baseUrl: opts.credentials.baseUrl,
    botToken: opts.credentials.botToken,
    getUpdatesBuf: cursor,
    fetchImpl: opts.fetchImpl,
    signal: perRequestSignal,
  });
}

function handleSessionExpiry(resp: GetUpdatesResp, onSessionExpired?: () => void): void {
  if (!isSessionExpired(resp)) return;
  onSessionExpired?.();
  throw new WeixinSessionExpiredError();
}

function nextLongpollTimeoutMs(resp: GetUpdatesResp): number | undefined {
  if (typeof resp.longpolling_timeout_ms === 'number' && resp.longpolling_timeout_ms > 0) {
    return resp.longpolling_timeout_ms + LONGPOLL_TIMEOUT_MARGIN_MS;
  }
  return undefined;
}

async function applySuccessfulPoll(
  resp: GetUpdatesResp,
  opts: RunUpdateLoopOpts,
  cursor: string
): Promise<string> {
  await dispatchMessages(resp.msgs ?? [], opts);
  return persistCursor(resp, cursor, opts.saveCursor);
}

async function dispatchMessages(msgs: WeixinMessage[], opts: RunUpdateLoopOpts): Promise<void> {
  for (const msg of msgs) {
    if (opts.signal.aborted) break;
    const inbound = opts.toInbound(msg);
    if (msg.from_user_id && msg.context_token) {
      opts.onContextToken?.(msg.from_user_id, msg.context_token);
    }
    try {
      await opts.onMessage?.(inbound);
    } catch (err) {
      opts.onError?.(err);
    }
  }
}

async function persistCursor(
  resp: GetUpdatesResp,
  cursor: string,
  saveCursor?: (buf: string) => void | Promise<void>
): Promise<string> {
  if (resp.get_updates_buf == null || resp.get_updates_buf === '') return cursor;
  await saveCursor?.(resp.get_updates_buf);
  return resp.get_updates_buf;
}

async function backoffSleep(failures: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(computeBackoffMs(failures), signal);
  } catch {
    // abort 期间被打断，交由 while 条件收尾
  }
}
