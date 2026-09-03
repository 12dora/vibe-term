import type { LinkSession, ServerSocketAdapter, WebSocketTransportInput } from '@tmex/shared/link';
import type { UserStore } from '../auth/user-store';
import { envInt } from './mesh-log';
import { type ReachabilityFailureKind, dedupeRankedPeerEndpoints } from './peer-endpoint-backoff';
import { type PeerHandshakeResult, handshakeWsDirect } from './peer-protocol';
import { type MeshIdentity, PeerHandshakeError } from './types';

export { isReachabilityFailureKind } from './peer-endpoint-backoff';

export type WsSecureCandidate = {
  session: LinkSession;
  peerNodeId: string;
  sendKey?: Uint8Array;
  recvKey?: Uint8Array;
  url: string;
};

export const PEER_DIRECT_DIAL_CONCURRENCY = 4;

export type WsDialFailureKind = ReachabilityFailureKind | 'protocol' | 'aborted' | 'other';

export class WsDialError extends Error {
  readonly kind: WsDialFailureKind;
  readonly url: string;

  constructor(kind: WsDialFailureKind, url: string, cause?: unknown) {
    const raw = cause instanceof Error ? cause.message : cause != null ? String(cause) : kind;
    super(raw.trim() || kind);
    this.name = 'WsDialError';
    this.kind = kind;
    this.url = url;
  }
}

export class DirectDialLimiter {
  private inflight = 0;
  private readonly waiters: Array<{
    grant: () => void;
    fail: (err: unknown) => void;
    signal: AbortSignal;
    onAbort: () => void;
  }> = [];

  constructor(readonly max = PEER_DIRECT_DIAL_CONCURRENCY) {}

  get active(): number {
    return this.inflight;
  }

  async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    if (this.inflight < this.max) {
      this.inflight += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const idx = this.waiters.findIndex((row) => row.onAbort === onAbort);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(signal.reason ?? new Error('aborted'));
      };
      this.waiters.push({
        grant: resolve,
        fail: reject,
        signal,
        onAbort,
      });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.signal.removeEventListener('abort', next.onAbort);
      next.grant();
      return;
    }
    this.inflight = Math.max(0, this.inflight - 1);
  }
}

let sharedLimiter: DirectDialLimiter | null = null;

export function sharedDirectDialLimiter(): DirectDialLimiter {
  sharedLimiter ??= new DirectDialLimiter(
    envInt('TMEX_PEER_DIRECT_DIAL_CONCURRENCY', PEER_DIRECT_DIAL_CONCURRENCY, 1)
  );
  return sharedLimiter;
}

export function resetSharedDirectDialLimiter(limiter?: DirectDialLimiter): void {
  sharedLimiter =
    limiter ??
    new DirectDialLimiter(
      envInt('TMEX_PEER_DIRECT_DIAL_CONCURRENCY', PEER_DIRECT_DIAL_CONCURRENCY, 1)
    );
}

function errorErrno(err: unknown): string {
  if (typeof err === 'object' && err && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string') return code.toUpperCase();
  }
  return '';
}

export function classifyWsDialFailure(url: string, err: unknown): WsDialError {
  if (err instanceof WsDialError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  const errno = errorErrno(err);
  if (lower.includes('aborted') || lower === 'stopped' || lower.includes('ws-race-lost')) {
    return new WsDialError('aborted', url, err);
  }
  if (err instanceof PeerHandshakeError) {
    if (err.code === 'timeout') return new WsDialError('timeout', url, err);
    if (err.code === 'bad_signature' || err.code === 'revoked') {
      return new WsDialError('protocol', url, err);
    }
  }
  if (errno === 'ECONNREFUSED' || lower.includes('econnrefused')) {
    return new WsDialError('refused', url, err);
  }
  if (
    errno === 'EHOSTUNREACH' ||
    errno === 'ENETUNREACH' ||
    lower.includes('ehostunreach') ||
    lower.includes('enetunreach')
  ) {
    return new WsDialError('unreachable', url, err);
  }
  if (
    errno === 'ECONNRESET' ||
    errno === 'EPIPE' ||
    lower.includes('econnreset') ||
    lower.includes('reset') ||
    lower === 'ws-closed'
  ) {
    return new WsDialError('reset', url, err);
  }
  if (lower.includes('connect-timeout')) return new WsDialError('open-timeout', url, err);
  if (
    lower.includes('refused') ||
    lower.includes('failed to connect') ||
    lower.includes('unable to connect') ||
    lower.includes('connection failed')
  ) {
    return new WsDialError('refused', url, err);
  }
  if (
    lower.includes('handshake') ||
    lower.includes('peer-id') ||
    lower.includes('transcript') ||
    lower.includes('not-trusted') ||
    lower.includes('bad_signature') ||
    (err instanceof PeerHandshakeError && err.code === 'protocol')
  ) {
    return new WsDialError('protocol', url, err);
  }
  if (lower.includes('timeout') || lower.includes('dial-timeout')) {
    return new WsDialError('timeout', url, err);
  }
  return new WsDialError('other', url, err);
}

function isServerSocketAdapter(value: WebSocketTransportInput): value is ServerSocketAdapter {
  return (
    typeof (value as ServerSocketAdapter).onDrain === 'function' &&
    typeof (value as ServerSocketAdapter).onMessage === 'function'
  );
}

export function quiet(fn: () => void): void {
  try {
    fn();
  } catch {
    // ignore
  }
}

export function closeWsTransport(ws: WebSocketTransportInput): void {
  quiet(() => {
    if (isServerSocketAdapter(ws)) ws.close(1000, 'stopped');
    else (ws as WebSocket).close(1000, 'stopped');
  });
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error('aborted'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

export function combineAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const ac = new AbortController();
  const onAbort = () => {
    if (!ac.signal.aborted) ac.abort();
  };
  if (a.aborted || b.aborted) {
    ac.abort();
    return ac.signal;
  }
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return ac.signal;
}

export function formatWsDialFailure(url: string, err: unknown): string {
  const classified = classifyWsDialFailure(url, err);
  const msg = classified.message.trim() || 'failed';
  if (classified.kind === 'timeout' || classified.kind === 'open-timeout') {
    return `timeout ${url}`;
  }
  if (classified.kind === 'refused') return `refused ${url}`;
  if (classified.kind === 'unreachable') return `unreachable ${url}`;
  if (classified.kind === 'reset') return `reset ${url}`;
  if (classified.kind === 'protocol') return `handshake: ${msg}`;
  return `${msg} ${url}`;
}

function waitSocketOpen(
  ws: WebSocketTransportInput,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (isServerSocketAdapter(ws)) return Promise.resolve();
  const socket = ws as WebSocket;
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      quiet(() => socket.close(1000, 'stopped'));
      finish(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      quiet(() => socket.close(1000, 'connect-timeout'));
      finish(new Error('connect-timeout'));
    }, timeoutMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.addEventListener('open', () => finish(), { once: true });
    socket.addEventListener('close', (ev) => finish(new Error(ev.reason || 'ws-closed')), {
      once: true,
    });
  });
}

export async function connectWsTransport(opts: {
  factory: (url: string) => WebSocketTransportInput | Promise<WebSocketTransportInput>;
  url: string;
  signal: AbortSignal;
  connectTimeoutMs: number;
}): Promise<WebSocketTransportInput> {
  const pending = Promise.resolve(opts.factory(opts.url));
  const abandon = () => {
    void pending.then(
      (ws) => closeWsTransport(ws),
      () => undefined
    );
  };
  if (opts.signal.aborted) {
    abandon();
    throw opts.signal.reason ?? new Error('aborted');
  }
  let ws: WebSocketTransportInput;
  try {
    ws = await abortable(pending, opts.signal);
  } catch (err) {
    abandon();
    throw err;
  }
  if (opts.signal.aborted) {
    closeWsTransport(ws);
    throw opts.signal.reason ?? new Error('aborted');
  }
  try {
    await waitSocketOpen(ws, opts.connectTimeoutMs, opts.signal);
  } catch (err) {
    closeWsTransport(ws);
    throw err;
  }
  if (opts.signal.aborted) {
    closeWsTransport(ws);
    throw new Error('stopped');
  }
  return ws;
}

function candidateFromHandshake(
  result: PeerHandshakeResult,
  expectedId: string,
  stale: boolean,
  aborted: boolean,
  url: string
): WsSecureCandidate {
  if (result.peerNodeId !== expectedId) {
    result.session.close('peer-id-mismatch');
    throw new Error('peer-id-mismatch');
  }
  if (stale || aborted) {
    result.session.close('stopped');
    throw new Error('stopped');
  }
  return {
    session: result.session,
    peerNodeId: result.peerNodeId,
    sendKey: result.sendKey,
    recvKey: result.recvKey,
    url,
  };
}

type DialBudget = {
  combined: AbortSignal;
  budgetExpired: () => boolean;
  connectTimeoutMs: (base: number) => number;
  handshakeTimeoutMs: (elapsed: number) => number | undefined;
  dispose: () => void;
};

function createDialBudget(signal: AbortSignal, totalMs: number | undefined): DialBudget {
  const totalAc = totalMs != null ? new AbortController() : null;
  const totalTimer =
    totalAc && totalMs != null
      ? setTimeout(() => totalAc.abort(new Error('dial-timeout')), totalMs)
      : null;
  const combined = totalAc ? combineAbortSignals(signal, totalAc.signal) : signal;
  return {
    combined,
    budgetExpired: () => Boolean(totalAc?.signal.aborted && !signal.aborted),
    connectTimeoutMs: (base) => (totalMs != null ? Math.min(base, Math.max(1, totalMs)) : base),
    handshakeTimeoutMs: (elapsed) => (totalMs != null ? Math.max(1, totalMs - elapsed) : undefined),
    dispose: () => {
      if (totalTimer != null) clearTimeout(totalTimer);
    },
  };
}

async function handshakeOrClose(
  ws: WebSocketTransportInput,
  opts: {
    expectedId: string;
    gen: number;
    stale: (gen: number) => boolean;
    url: string;
    identity: MeshIdentity;
    userStore: UserStore;
    started: number;
    handshakeTimeoutMs: (elapsed: number) => number | undefined;
    fallbackHandshakeTimeoutMs?: number;
    budgetExpired: () => boolean;
  },
  combined: AbortSignal
): Promise<WsSecureCandidate> {
  if (opts.stale(opts.gen) || combined.aborted) {
    closeWsTransport(ws);
    if (opts.budgetExpired()) throw new WsDialError('timeout', opts.url, new Error('dial-timeout'));
    throw new Error('stopped');
  }
  const handshakeTimeoutMs =
    opts.handshakeTimeoutMs(Date.now() - opts.started) ?? opts.fallbackHandshakeTimeoutMs;
  let handshakeSession: LinkSession | null = null;
  try {
    const result = await abortable(
      handshakeWsDirect({
        socket: ws,
        role: 'initiator',
        identity: opts.identity,
        userStore: opts.userStore,
        timeoutMs: handshakeTimeoutMs,
      }).then((row) => {
        handshakeSession = row.session;
        return row;
      }),
      combined
    );
    return candidateFromHandshake(
      result,
      opts.expectedId,
      opts.stale(opts.gen),
      combined.aborted,
      opts.url
    );
  } catch (err) {
    if (handshakeSession) quiet(() => handshakeSession?.close('stopped'));
    else closeWsTransport(ws);
    throw err;
  }
}

export async function dialWsSecureCandidate(opts: {
  url: string;
  expectedId: string;
  gen: number;
  signal: AbortSignal;
  stale: (gen: number) => boolean;
  connectTimeoutMs: number;
  totalTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  factory: (url: string) => WebSocketTransportInput | Promise<WebSocketTransportInput>;
  identity: MeshIdentity;
  userStore: UserStore;
  limiter?: DirectDialLimiter;
}): Promise<WsSecureCandidate | null> {
  if (opts.signal.aborted || opts.stale(opts.gen)) return null;
  const limiter = opts.limiter ?? sharedDirectDialLimiter();
  const budget = createDialBudget(opts.signal, opts.totalTimeoutMs);
  const started = Date.now();
  let acquired = false;
  try {
    await limiter.acquire(budget.combined);
    acquired = true;
    if (budget.combined.aborted || opts.stale(opts.gen)) {
      if (budget.budgetExpired())
        throw new WsDialError('timeout', opts.url, new Error('dial-timeout'));
      return null;
    }
    const ws = await connectWsTransport({
      factory: opts.factory,
      url: opts.url,
      signal: budget.combined,
      connectTimeoutMs: budget.connectTimeoutMs(opts.connectTimeoutMs),
    });
    return await handshakeOrClose(
      ws,
      {
        expectedId: opts.expectedId,
        gen: opts.gen,
        stale: opts.stale,
        url: opts.url,
        identity: opts.identity,
        userStore: opts.userStore,
        started,
        handshakeTimeoutMs: budget.handshakeTimeoutMs,
        fallbackHandshakeTimeoutMs: opts.handshakeTimeoutMs,
        budgetExpired: budget.budgetExpired,
      },
      budget.combined
    );
  } catch (err) {
    if (budget.budgetExpired()) return Promise.reject(new WsDialError('timeout', opts.url, err));
    throw classifyWsDialFailure(opts.url, err);
  } finally {
    budget.dispose();
    if (acquired) limiter.release();
  }
}

type RaceState = {
  winner: WsSecureCandidate | null;
  winnerCtl: AbortController | null;
  lastReason: string | null;
};

function abortOtherControllers(controllers: AbortController[], keep: AbortController | null): void {
  for (const child of controllers) {
    if (child === keep || child.signal.aborted) continue;
    child.abort();
  }
}

function abortRaceParent(state: RaceState, controllers: AbortController[]): void {
  abortOtherControllers(controllers, state.winnerCtl);
  if (!state.winner) return;
  quiet(() => state.winner?.session.close('stopped'));
  state.winner = null;
  state.winnerCtl = null;
}

function takeRaceWinner(
  state: RaceState,
  candidate: WsSecureCandidate | null,
  child: AbortController,
  combined: AbortSignal,
  stale: boolean,
  controllers: AbortController[]
): void {
  if (!candidate) return;
  if (state.winner || stale || combined.aborted) {
    quiet(() => candidate.session.close('ws-race-lost'));
    return;
  }
  state.winner = candidate;
  state.winnerCtl = child;
  abortOtherControllers(controllers, child);
}

function noteRaceFailure(
  state: RaceState,
  url: string,
  err: unknown,
  combined: AbortSignal,
  stale: boolean
): void {
  if (combined.aborted || stale) return;
  state.lastReason = formatWsDialFailure(url, err);
}

export async function raceWsSecureEndpoints(opts: {
  urls: string[];
  gen: number;
  signal: AbortSignal;
  stale: (gen: number) => boolean;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  staggerMs: number;
  dial: (url: string, signal: AbortSignal) => Promise<WsSecureCandidate | null>;
}): Promise<{ winner: WsSecureCandidate | null; lastReason: string | null }> {
  const urls = dedupeRankedPeerEndpoints(opts.urls);
  const state: RaceState = { winner: null, winnerCtl: null, lastReason: null };
  const controllers: AbortController[] = [];
  const abortLosers = () => abortOtherControllers(controllers, state.winnerCtl);
  if (opts.signal.aborted || opts.stale(opts.gen)) {
    return { winner: null, lastReason: null };
  }
  const onParentAbort = () => abortRaceParent(state, controllers);
  opts.signal.addEventListener('abort', onParentAbort, { once: true });
  try {
    await new Promise<void>((resolve) => {
      let left = urls.length;
      const oneDone = () => {
        left -= 1;
        if (state.winner || left <= 0) resolve();
      };
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i] ?? '';
        const child = new AbortController();
        controllers.push(child);
        const combined = combineAbortSignals(opts.signal, child.signal);
        void (async () => {
          if (i > 0) await opts.sleep(i * opts.staggerMs, combined);
          if (combined.aborted || opts.stale(opts.gen)) return null;
          return opts.dial(url, combined);
        })()
          .then((candidate) =>
            takeRaceWinner(state, candidate, child, combined, opts.stale(opts.gen), controllers)
          )
          .catch((err) => noteRaceFailure(state, url, err, combined, opts.stale(opts.gen)))
          .finally(oneDone);
      }
    });
  } finally {
    opts.signal.removeEventListener('abort', onParentAbort);
    abortLosers();
  }
  return { winner: state.winner, lastReason: state.lastReason };
}
