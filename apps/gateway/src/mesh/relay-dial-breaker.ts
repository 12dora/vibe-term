import {
  DIAL_BREAKER_BASE_MS,
  DIAL_BREAKER_FAILS,
  DIAL_BREAKER_MAX_MS,
  DialBreaker,
  type DialBreakerDecision,
  type DialBreakerFailureResult,
  type DialBreakerResetEvent,
  type DialBreakerSnapshot,
  type DialBreakerTripEvent,
} from '@vibeterm/shared/net';
import { envInt, isoNow, logLine } from './mesh-log';
import { NodeUnreachableError, PeerHandshakeError } from './types';
import { UPLINK_CONNECT_LOG_INTERVAL_MS } from './uplink-constants';

export const RELAY_DIAL_BREAKER_FAILS = DIAL_BREAKER_FAILS;
export const RELAY_DIAL_BREAKER_BASE_MS = DIAL_BREAKER_BASE_MS;
export const RELAY_DIAL_BREAKER_MAX_MS = DIAL_BREAKER_MAX_MS;
export const RELAY_RETRYABLE_BACKOFF_MS = 1_000;
export const RELAY_RETRYABLE_BACKOFF_MAX_MS = 8_000;
export const RELAY_DIAL_JITTER = 0.2;
export const RELAY_CHOOSE_LOG_INTERVAL_MS = UPLINK_CONNECT_LOG_INTERVAL_MS;

export const RELAY_DIAL_FAILURE_KINDS = [
  'handshake-timeout',
  'open-failed',
  'rst',
  'peer-id-mismatch',
  'offline',
  'unknown-target',
] as const;
export type RelayDialFailureKind = (typeof RELAY_DIAL_FAILURE_KINDS)[number];

const RETRYABLE_KINDS = new Set<string>(['offline', 'unknown-target']);
const SKIP_KINDS = new Set([
  'aborted',
  'breaker_cooling',
  'simultaneous-dial',
  'stale',
  'not-trusted',
  'skip',
  'uplink is not online',
  'uplink-retiring',
  'unauthenticated',
  'relay-unhandled',
  'quota-streams',
  'relay-open-local',
]);

export type RelayDialBreakerDecision = DialBreakerDecision & { disabled: boolean };
export type RelayDialBreakerSnapshot = DialBreakerSnapshot & { disabled: boolean };
export type RelayDialBreakerTripEvent = DialBreakerTripEvent;
export type RelayDialBreakerResetEvent = DialBreakerResetEvent;
export type RelayDialFailureResult = DialBreakerFailureResult;

type RetryableState = { until: number; failures: number };
type ChooseLogState = { via: string; at: number };

export type RelayDialBreakerOptions = {
  now?: () => number;
  random?: () => number;
  breakerMs?: number;
  failLimit?: number;
  maxMs?: number;
  jitter?: number;
  retryableMs?: number;
  retryableMaxMs?: number;
  chooseLogIntervalMs?: number;
  onTrip?: (event: RelayDialBreakerTripEvent) => void;
  onReset?: (event: RelayDialBreakerResetEvent) => void;
  log?: (msg: string, at?: Date) => void;
};

export function classifyRelayDialFailure(err: unknown): string {
  if (err instanceof NodeUnreachableError) return classifyUnreachable(err.message);
  if (err instanceof PeerHandshakeError) {
    return err.code === 'timeout' ? 'handshake-timeout' : 'open-failed';
  }
  const retryable = retryableKindOf(err);
  if (retryable) return retryable;
  const msg = err instanceof Error ? err.message : String(err);
  return classifyFailureMessage(msg);
}

function retryableKindOf(err: unknown): string | null {
  const raw = typeof err === 'string' ? err : err instanceof Error ? err.message : null;
  return raw && RETRYABLE_KINDS.has(raw) ? raw : null;
}

function classifyUnreachable(message: string): string {
  if (SKIP_KINDS.has(message)) return 'skip';
  if (message.includes('peer id mismatch')) return 'peer-id-mismatch';
  return classifyFailureMessage(message);
}

function classifyFailureMessage(message: string): string {
  const lower = message.toLowerCase();
  if (SKIP_KINDS.has(lower)) return 'skip';
  if (RETRYABLE_KINDS.has(lower)) return lower;
  if (lower.includes('handshake') && (lower.includes('timeout') || lower.includes('timed out'))) {
    return 'handshake-timeout';
  }
  if (lower.includes('timed out') || lower.includes('timeout')) return 'handshake-timeout';
  if (lower.includes('rst')) return 'rst';
  if (lower === 'open-failed') return 'skip';
  return 'open-failed';
}

export function isRetryableRelayFailureKind(kind: string): boolean {
  return RETRYABLE_KINDS.has(kind);
}

export class RelayChooseLogGate {
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly last = new Map<string, ChooseLogState>();

  constructor(opts: { now?: () => number; intervalMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.intervalMs = opts.intervalMs ?? RELAY_CHOOSE_LOG_INTERVAL_MS;
  }

  /** 首次选中、切换 via、冷却窗口外才打印；状态变化由调用方另打。 */
  shouldLog(peer: string, via: string, now = this.now()): boolean {
    const prev = this.last.get(peer);
    if (!prev || prev.via !== via || now - prev.at >= this.intervalMs) {
      this.last.set(peer, { via, at: now });
      return true;
    }
    return false;
  }

  reset(peer?: string): void {
    if (peer) this.last.delete(peer);
    else this.last.clear();
  }
}

export class RelayDialBreaker {
  private readonly inner: DialBreaker;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly jitter: number;
  private readonly retryableMs: number;
  private readonly retryableMaxMs: number;
  private readonly onTrip?: (event: RelayDialBreakerTripEvent) => void;
  private readonly onReset?: (event: RelayDialBreakerResetEvent) => void;
  private readonly log: (msg: string, at?: Date) => void;
  readonly chooseLog: RelayChooseLogGate;
  private readonly retryable = new Map<string, RetryableState>();
  private readonly jitterUntil = new Map<string, number>();
  private readonly lastKind = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(opts: RelayDialBreakerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.jitter = clampJitter(opts.jitter ?? RELAY_DIAL_JITTER);
    this.retryableMs = opts.retryableMs ?? RELAY_RETRYABLE_BACKOFF_MS;
    this.retryableMaxMs = opts.retryableMaxMs ?? RELAY_RETRYABLE_BACKOFF_MAX_MS;
    this.onTrip = opts.onTrip;
    this.onReset = opts.onReset;
    this.log = opts.log ?? ((msg, at) => logLine('[mesh][peer]', msg, at));
    this.chooseLog = new RelayChooseLogGate({
      now: this.now,
      intervalMs: opts.chooseLogIntervalMs,
    });
    this.inner = new DialBreaker({
      now: this.now,
      breakerMs: opts.breakerMs ?? RELAY_DIAL_BREAKER_BASE_MS,
      failLimit: opts.failLimit ?? RELAY_DIAL_BREAKER_FAILS,
      maxMs: opts.maxMs ?? RELAY_DIAL_BREAKER_MAX_MS,
      skipKinds: SKIP_KINDS,
      trackAttempts: true,
      onTrip: (event) => this.handleTrip(event),
    });
  }

  shouldTry(peer: string, now = this.now()): RelayDialBreakerDecision {
    const inner = this.inner.shouldTry(peer, now);
    const until = Math.max(
      inner.until ?? 0,
      this.retryUntil(peer),
      this.jitterUntil.get(peer) ?? 0
    );
    const cooling = until > now;
    if (!cooling) this.jitterUntil.delete(peer);
    const forceProbe = inner.allow && inner.cooling;
    return {
      allow: !cooling || forceProbe,
      cooling,
      until: cooling ? until : null,
      failures: inner.failures,
      level: inner.level,
      disabled: false,
    };
  }

  snapshot(peer: string, now = this.now()): RelayDialBreakerSnapshot {
    const decision = this.shouldTry(peer, now);
    const inner = this.inner.snapshot(peer, now);
    return {
      cooling: decision.cooling,
      until: decision.until,
      failures: decision.failures,
      level: decision.level,
      lastFailureKind: this.lastKind.get(peer) ?? inner.lastFailureKind,
      disabled: false,
    };
  }

  beginAttempt(peer: string, attemptId = `relay:${this.now()}`): void {
    this.inner.beginAttempt(peer, attemptId);
  }

  forceProbe(peer: string): void {
    this.inner.forceProbe(peer);
  }

  noteFailure(
    peer: string,
    kind = 'unknown',
    attemptId?: string,
    now = this.now()
  ): RelayDialFailureResult {
    if (SKIP_KINDS.has(kind)) {
      return { counted: false, opened: false, open: this.shouldTry(peer, now).cooling };
    }
    this.lastKind.set(peer, kind);
    if (isRetryableRelayFailureKind(kind)) return this.noteRetryable(peer, now);
    return this.inner.noteFailure(peer, kind, attemptId, now);
  }

  noteSuccess(peer: string, now = this.now()): void {
    const hadDebt = this.hasDebt(peer, now);
    this.retryable.delete(peer);
    this.jitterUntil.delete(peer);
    this.lastKind.delete(peer);
    this.inner.reset(peer);
    this.chooseLog.reset(peer);
    if (!hadDebt) return;
    this.onReset?.({ peer, healthyMs: 0 });
  }

  reset(peer?: string): void {
    if (peer) {
      this.retryable.delete(peer);
      this.jitterUntil.delete(peer);
      this.lastKind.delete(peer);
      this.chooseLog.reset(peer);
    } else {
      this.retryable.clear();
      this.jitterUntil.clear();
      this.lastKind.clear();
      this.chooseLog.reset();
    }
    this.inner.reset(peer);
  }

  /** 同一 peer 拨号阶段单飞；已建立的会话不走这里。 */
  singleFlight<T>(peer: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(peer);
    if (existing) return existing as Promise<T>;
    let work: Promise<T>;
    try {
      work = run();
    } catch (err) {
      work = Promise.reject(err);
    }
    this.inflight.set(peer, work);
    const clear = () => {
      if (this.inflight.get(peer) === work) this.inflight.delete(peer);
    };
    work.then(clear, clear);
    return work;
  }

  logChoose(peer: string, via: string, scoreMs: number | null, candidates: number): boolean {
    if (!this.chooseLog.shouldLog(peer, via)) return false;
    this.log(formatChoose(peer, via, scoreMs, candidates), new Date(this.now()));
    return true;
  }

  private noteRetryable(peer: string, now: number): RelayDialFailureResult {
    const prev = this.retryable.get(peer);
    const failures = (prev?.failures ?? 0) + 1;
    const delay = retryableDelayMs(failures, this.retryableMs, this.retryableMaxMs);
    const until = now + delay;
    this.retryable.set(peer, { until, failures });
    return { counted: true, opened: false, open: true, until };
  }

  private applyJitter(peer: string, innerUntil: number, now: number): void {
    if (this.jitter <= 0) return;
    const base = Math.max(1, innerUntil - now);
    const factor = 1 + this.jitter * (2 * this.random() - 1);
    this.jitterUntil.set(peer, now + Math.max(1, Math.round(base * factor)));
  }

  private handleTrip(event: RelayDialBreakerTripEvent): void {
    this.applyJitter(event.peer, event.until, this.now());
    const until = this.jitterUntil.get(event.peer) ?? event.until;
    this.onTrip?.({ ...event, until, cooldownMs: Math.max(1, until - this.now()) });
  }

  private retryUntil(peer: string): number {
    return this.retryable.get(peer)?.until ?? 0;
  }

  private hasDebt(peer: string, now: number): boolean {
    const snap = this.inner.snapshot(peer, now);
    return snap.failures > 0 || snap.level > 0 || snap.cooling || this.retryable.has(peer);
  }
}

function retryableDelayMs(failures: number, baseMs: number, maxMs: number): number {
  const exp = baseMs * 2 ** Math.max(0, failures - 1);
  return Math.min(maxMs, Math.max(1, exp));
}

function clampJitter(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(0.5, value);
}

function formatChoose(
  peer: string,
  via: string,
  scoreMs: number | null,
  candidates: number
): string {
  return `relay choose peer=${peer} via=${via} score_ms=${scoreMs ?? '-'} candidates=${candidates}`;
}

export function logRelayBreakerCooling(
  nodeId: string,
  until: number | null,
  now = Date.now()
): void {
  const untilText = until == null ? '-' : isoNow(new Date(until));
  logLine(
    '[mesh][peer]',
    `dial failed peer=${nodeId} cause=breaker_cooling until=${untilText}`,
    new Date(now)
  );
}

export function createGatewayRelayDialBreaker(
  opts: RelayDialBreakerOptions = {}
): RelayDialBreaker {
  return new RelayDialBreaker({
    ...opts,
    now: opts.now,
    breakerMs:
      opts.breakerMs ?? envInt('VIBETERM_RELAY_DIAL_BREAKER_MS', RELAY_DIAL_BREAKER_BASE_MS, 1),
    failLimit: opts.failLimit ?? envInt('VIBETERM_RELAY_DIAL_FAILS', RELAY_DIAL_BREAKER_FAILS, 1),
    maxMs: opts.maxMs ?? envInt('VIBETERM_RELAY_DIAL_MAX_MS', RELAY_DIAL_BREAKER_MAX_MS, 1),
    retryableMs:
      opts.retryableMs ??
      envInt('VIBETERM_RELAY_RETRYABLE_BACKOFF_MS', RELAY_RETRYABLE_BACKOFF_MS, 1),
    retryableMaxMs:
      opts.retryableMaxMs ??
      envInt('VIBETERM_RELAY_RETRYABLE_BACKOFF_MAX_MS', RELAY_RETRYABLE_BACKOFF_MAX_MS, 1),
    onTrip: (event) => {
      opts.onTrip?.(event);
      logLine(
        '[mesh][peer]',
        `relay breaker trip peer=${event.peer} fails=${event.fails} level=${event.level} cooldown_ms=${event.cooldownMs} until=${isoNow(new Date(event.until))}`
      );
    },
    onReset: (event) => {
      opts.onReset?.(event);
      logLine('[mesh][peer]', `relay breaker reset peer=${event.peer}`);
    },
  });
}

let defaultBreaker: RelayDialBreaker | null = null;

export function getRelayDialBreaker(): RelayDialBreaker {
  defaultBreaker ??= createGatewayRelayDialBreaker();
  return defaultBreaker;
}

export function setRelayDialBreakerForTests(breaker: RelayDialBreaker | null): void {
  defaultBreaker = breaker;
}
