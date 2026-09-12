import { waitSocketOpen } from '@vibeterm/shared/net';
import { classifyRemoteAddress, hostFromWsUrl } from './address-class';
import { logLine } from './mesh-log';
import { clampWsDialRace, wsDialRaceCount } from './ws-dial-race-config';

/** 单条 socket 等 `open` 的兜底上限；调用方通常通过 `ctx.timeoutMs` 给更紧的预算。 */
export const WS_RACE_OPEN_TIMEOUT_MS = 20_000;

/** 拨号上下文：竞速需要调用方的中止信号与连接预算，缺省时退回兜底超时。 */
export type WsDialContext = { signal?: AbortSignal; timeoutMs?: number };

export type WsOpenFactory<T> = (url: string) => T | Promise<T>;

export type WsOpenRaceOptions = {
  count: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
  now?: () => number;
};

type Closable = { close?: (code?: number, reason?: string) => void };

function closeQuiet(ws: unknown): void {
  try {
    (ws as Closable).close?.(1000, 'ws-race-loser');
  } catch {
    /* 输家的关闭失败无关紧要 */
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error('aborted');
}

class WsRaceState<T> {
  readonly created: T[] = [];
  readonly otherMs: number[] = [];
  winner: T | null = null;
  settled = false;
  lastError: unknown = null;
  pending: number;

  constructor(count: number) {
    this.pending = count;
  }

  closeLosers(): void {
    for (const ws of this.created) {
      if (ws !== this.winner) closeQuiet(ws);
    }
  }
}

async function openOne<T>(
  factory: WsOpenFactory<T>,
  url: string,
  state: WsRaceState<T>,
  opts: WsOpenRaceOptions
): Promise<T> {
  const ws = await factory(url);
  if (state.settled) {
    closeQuiet(ws);
    throw new Error('ws-race-settled');
  }
  state.created.push(ws);
  await waitSocketOpen(
    ws as object,
    opts.timeoutMs ?? WS_RACE_OPEN_TIMEOUT_MS,
    opts.signal,
    'ws-race-aborted'
  );
  return ws;
}

function logRace(
  url: string,
  winnerMs: number,
  otherMs: number[],
  count: number,
  log: ((line: string) => void) | undefined
): void {
  const host = hostFromWsUrl(url) ?? url;
  const others = otherMs.length > 0 ? otherMs.join(',') : '-';
  const line = `[mesh][dial] ws race url=${host} winner_ms=${winnerMs} others_ms=${others} count=${count}`;
  if (log) log(line);
  else logLine(line);
}

/**
 * 同时开 `count` 条 WebSocket，保留最先 `open` 的一条，其余立刻关掉（不发任何字节）。
 * 全部失败时抛最后一个错误；`count <= 1` 退化成一次普通 factory 调用，不打日志。
 */
export function raceWebSocketOpen<T>(
  factory: WsOpenFactory<T>,
  url: string,
  opts: WsOpenRaceOptions
): Promise<T> {
  const count = Math.floor(opts.count);
  if (!Number.isFinite(count) || count <= 1) return Promise.resolve(factory(url));
  return runRace(factory, url, { ...opts, count });
}

function runRace<T>(factory: WsOpenFactory<T>, url: string, opts: WsOpenRaceOptions): Promise<T> {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const state = new WsRaceState<T>(opts.count);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (state.settled) return;
      state.settled = true;
      state.closeLosers();
      reject(abortError(opts.signal));
    };
    const detach = () => opts.signal?.removeEventListener('abort', onAbort);
    const win = (ws: T) => {
      const elapsed = now() - startedAt;
      if (state.settled) {
        closeQuiet(ws);
        return;
      }
      state.settled = true;
      state.winner = ws;
      state.closeLosers();
      detach();
      logRace(url, elapsed, state.otherMs, opts.count, opts.log);
      resolve(ws);
    };
    const lose = (err: unknown) => {
      state.pending -= 1;
      if (state.settled) return;
      state.lastError = err;
      state.otherMs.push(now() - startedAt);
      if (state.pending > 0) return;
      state.settled = true;
      detach();
      reject(err ?? new Error('ws-race-failed'));
    };
    if (opts.signal?.aborted) {
      reject(abortError(opts.signal));
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    for (let i = 0; i < opts.count; i++) {
      void openOne(factory, url, state, opts).then(win, lose);
    }
  });
}

/** 回环 / RFC1918 / 链路本地不竞速：局域网没有跨境 ECMP 问题，多开只是浪费握手。 */
export function wsRaceCountForUrl(url: string, count: number = wsDialRaceCount()): number {
  const host = hostFromWsUrl(url);
  if (host && classifyRemoteAddress(host) === 'lan') return 1;
  return clampWsDialRace(count);
}

/** 把普通 factory 包成带竞速的 factory；注入过 `wsFactory` 的调用方不受影响。 */
export function withWsOpenRace<T>(
  factory: WsOpenFactory<T>,
  opts?: { count?: number; log?: (line: string) => void; now?: () => number }
): (url: string, ctx?: WsDialContext) => Promise<T> {
  return (url, ctx) =>
    raceWebSocketOpen(factory, url, {
      count: wsRaceCountForUrl(url, opts?.count ?? wsDialRaceCount()),
      timeoutMs: ctx?.timeoutMs,
      signal: ctx?.signal,
      log: opts?.log,
      now: opts?.now,
    });
}
