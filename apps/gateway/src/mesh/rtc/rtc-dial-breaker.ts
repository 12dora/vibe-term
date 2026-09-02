import { envInt } from '../mesh-log';
import { flushDialFailed, rtcLog } from './rtc-log';

export const RTC_DIAL_BREAKER_FAILS = 3;
export const RTC_DIAL_BREAKER_BASE_MS_DEFAULT = 30_000;
export const RTC_DIAL_BREAKER_MAX_MS = 30 * 60 * 1000;
export const RTC_DIAL_BREAKER_HEALTHY_MS = 60_000;

/** @deprecated 使用 RTC_DIAL_BREAKER_BASE_MS_DEFAULT；保留别名以免旧测试引用断裂。 */
export const RTC_DIAL_BREAKER_MS_DEFAULT = RTC_DIAL_BREAKER_BASE_MS_DEFAULT;

export type RtcDialBreakerDecision = {
  allow: boolean;
  cooling: boolean;
  until: number | null;
  failures: number;
  level: number;
};

export type RtcDialBreakerSnapshot = {
  cooling: boolean;
  until: number | null;
  failures: number;
  level: number;
  lastFailureKind: string | null;
};

export type RtcDialBreakerTripEvent = {
  peer: string;
  fails: number;
  level: number;
  cooldownMs: number;
  until: number;
};

export type RtcDialBreakerResetEvent = {
  peer: string;
  healthyMs: number;
};

export type RtcDialFailureResult = {
  counted: boolean;
  opened: boolean;
  open: boolean;
  until?: number;
};

type PeerState = {
  consecutiveFailures: number;
  cooldownLevel: number;
  coolingUntil: number;
  healthySince: number | null;
  lastFailureKind: string | null;
  lastFailureAt: number;
  activeAttempt: string | null;
  lastCountedAttempt: string | null;
  establishedAttempt: string | null;
  forceProbe: boolean;
};

export type RtcDialBreakerOptions = {
  now?: () => number;
  breakerMs?: number;
  failLimit?: number;
  healthyMs?: number;
  maxMs?: number;
  onTrip?: (event: RtcDialBreakerTripEvent) => void;
  onReset?: (event: RtcDialBreakerResetEvent) => void;
  /** @deprecated 使用 onTrip */
  onOpen?: (event: { peer: string; fails: number; until: number }) => void;
};

const INTENTIONAL_DC_LOSS = new Set([
  'stopped',
  'revoked',
  'idle',
  'replaced',
  'stale',
  'not-trusted',
  'lower-priority',
  'simultaneous-dial',
]);

export function isIntentionalDcLoss(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return INTENTIONAL_DC_LOSS.has(reason);
}

export function classifyRtcDialFailure(reason: string | null | undefined): string {
  if (!reason) return 'unknown';
  const r = reason.toLowerCase();
  if (r.includes('liveness')) return 'liveness-timeout';
  if (r.includes('missed-pong') || r.includes('missed pong')) return 'missed-pong';
  if (r.includes('timeout') || r.includes('timed out')) return 'timeout';
  if (r.includes('ice')) return 'ice';
  if (r.includes('abort')) return 'abort';
  if (
    r.includes('fingerprint') ||
    r.includes('protocol') ||
    r.includes('handshake') ||
    r.includes('fragment')
  ) {
    return 'protocol';
  }
  if (r.includes('channel-error') || r.includes('datachannel error')) return 'channel-error';
  if (
    r.includes('channel-closed') ||
    r.includes('datachannel closed') ||
    r.includes('channel closed')
  ) {
    return 'channel-closed';
  }
  if (r.includes('transport')) return 'transport-lost';
  if (r === 'closed') return 'channel-closed';
  return reason.length > 64 ? reason.slice(0, 64) : reason;
}

export class RtcDialBreaker {
  private readonly now: () => number;
  private readonly breakerMs: number;
  private readonly failLimit: number;
  private readonly healthyMs: number;
  private readonly maxMs: number;
  private readonly onTrip?: (event: RtcDialBreakerTripEvent) => void;
  private readonly onReset?: (event: RtcDialBreakerResetEvent) => void;
  private readonly peers = new Map<string, PeerState>();

  constructor(opts: RtcDialBreakerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.breakerMs =
      opts.breakerMs ?? envInt('TMEX_RTC_DIAL_BREAKER_MS', RTC_DIAL_BREAKER_BASE_MS_DEFAULT, 1);
    this.failLimit = opts.failLimit ?? RTC_DIAL_BREAKER_FAILS;
    this.healthyMs = opts.healthyMs ?? RTC_DIAL_BREAKER_HEALTHY_MS;
    this.maxMs = opts.maxMs ?? RTC_DIAL_BREAKER_MAX_MS;
    this.onTrip =
      opts.onTrip ??
      (opts.onOpen
        ? (event) => opts.onOpen?.({ peer: event.peer, fails: event.fails, until: event.until })
        : undefined);
    this.onReset = opts.onReset;
  }

  shouldTry(peer: string, now = this.now()): RtcDialBreakerDecision {
    const state = this.peers.get(peer);
    if (!state) {
      return { allow: true, cooling: false, until: null, failures: 0, level: 0 };
    }
    const cooling = state.coolingUntil > now;
    const allow = !cooling || state.forceProbe;
    return {
      allow,
      cooling,
      until: cooling ? state.coolingUntil : null,
      failures: state.consecutiveFailures,
      level: state.cooldownLevel,
    };
  }

  /** @deprecated 使用 shouldTry().allow */
  shouldSkip(peer: string, now = this.now()): boolean {
    return !this.shouldTry(peer, now).allow;
  }

  snapshot(peer: string, now = this.now()): RtcDialBreakerSnapshot {
    const decision = this.shouldTry(peer, now);
    const state = this.peers.get(peer);
    return {
      cooling: decision.cooling,
      until: decision.until,
      failures: decision.failures,
      level: decision.level,
      lastFailureKind: state?.lastFailureKind ?? null,
    };
  }

  beginAttempt(peer: string, attemptId: string): void {
    const state = this.ensure(peer);
    state.activeAttempt = attemptId;
    if (state.forceProbe) state.forceProbe = false;
  }

  forceProbe(peer: string): void {
    this.ensure(peer).forceProbe = true;
  }

  noteFailure(
    peer: string,
    kind = 'unknown',
    attemptId?: string,
    now = this.now()
  ): RtcDialFailureResult {
    const state = this.ensure(peer);
    if (attemptId && state.lastCountedAttempt === attemptId) {
      return {
        counted: false,
        opened: false,
        open: state.coolingUntil > now,
        until: state.coolingUntil > now ? state.coolingUntil : undefined,
      };
    }
    if (attemptId) state.lastCountedAttempt = attemptId;
    state.activeAttempt = null;
    state.healthySince = null;
    state.establishedAttempt = null;
    state.consecutiveFailures += 1;
    state.lastFailureKind = kind;
    state.lastFailureAt = now;
    if (state.coolingUntil > now) {
      return { counted: true, opened: false, open: true, until: state.coolingUntil };
    }
    if (state.consecutiveFailures < this.failLimit) {
      return { counted: true, opened: false, open: false };
    }
    const cooldownMs = this.cooldownMs(state.cooldownLevel);
    const until = now + cooldownMs;
    state.coolingUntil = until;
    const level = state.cooldownLevel;
    state.cooldownLevel = Math.min(state.cooldownLevel + 1, this.maxLevel());
    this.onTrip?.({ peer, fails: state.consecutiveFailures, level, cooldownMs, until });
    return { counted: true, opened: true, open: true, until };
  }

  noteChannelEstablished(peer: string, attemptId?: string, now = this.now()): void {
    const state = this.ensure(peer);
    if (attemptId && state.lastCountedAttempt === attemptId) return;
    state.activeAttempt = attemptId ?? null;
    state.establishedAttempt = attemptId ?? null;
    state.healthySince = now;
  }

  noteHealthy(peer: string, now = this.now()): boolean {
    const state = this.peers.get(peer);
    if (!state || state.healthySince == null) return false;
    const healthyMs = Math.max(0, now - state.healthySince);
    if (healthyMs < this.healthyMs) return false;
    const hadDebt =
      state.consecutiveFailures > 0 || state.cooldownLevel > 0 || state.coolingUntil > 0;
    state.consecutiveFailures = 0;
    state.cooldownLevel = 0;
    state.coolingUntil = 0;
    state.lastFailureKind = null;
    state.lastFailureAt = 0;
    state.forceProbe = false;
    state.lastCountedAttempt = null;
    state.activeAttempt = null;
    if (hadDebt) this.onReset?.({ peer, healthyMs });
    return hadDebt;
  }

  /**
   * 对端 endpoints / inventory / direct_capable 变化不再复位计数。
   * 只清掉尚未落地的 in-flight attempt 标记。
   */
  notePeerChanged(peer: string): void {
    const state = this.peers.get(peer);
    if (state) state.activeAttempt = null;
  }

  /** @deprecated 健康满 60s 才复位；保留给旧调用方，行为改为 no-op。 */
  noteSuccess(_peer: string): void {}

  reset(peer?: string): void {
    if (peer) this.peers.delete(peer);
    else this.peers.clear();
  }

  private ensure(peer: string): PeerState {
    let state = this.peers.get(peer);
    if (!state) {
      state = {
        consecutiveFailures: 0,
        cooldownLevel: 0,
        coolingUntil: 0,
        healthySince: null,
        lastFailureKind: null,
        lastFailureAt: 0,
        activeAttempt: null,
        lastCountedAttempt: null,
        establishedAttempt: null,
        forceProbe: false,
      };
      this.peers.set(peer, state);
    }
    return state;
  }

  private cooldownMs(level: number): number {
    const exp = Math.min(this.breakerMs * 2 ** Math.max(0, level), this.maxMs);
    return Math.max(1, exp);
  }

  private maxLevel(): number {
    if (this.breakerMs >= this.maxMs) return 0;
    let level = 0;
    while (this.breakerMs * 2 ** (level + 1) <= this.maxMs) level += 1;
    return level;
  }
}

export function createGatewayRtcDialBreaker(opts: RtcDialBreakerOptions = {}): RtcDialBreaker {
  return new RtcDialBreaker({
    ...opts,
    onTrip: (event) => {
      opts.onTrip?.(event);
      flushDialFailed(event.peer, { cause: 'breaker_trip' });
      rtcLog('breaker trip', {
        peer: event.peer,
        fails: event.fails,
        level: event.level,
        cooldown_ms: event.cooldownMs,
        until: new Date(event.until).toISOString(),
      });
    },
    onReset: (event) => {
      opts.onReset?.(event);
      rtcLog('breaker reset', {
        peer: event.peer,
        healthy_ms: event.healthyMs,
      });
    },
  });
}
