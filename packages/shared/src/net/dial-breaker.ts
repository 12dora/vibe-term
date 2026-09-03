export const DIAL_BREAKER_FAILS = 3;
export const DIAL_BREAKER_BASE_MS = 30_000;
export const DIAL_BREAKER_MAX_MS = 30 * 60 * 1000;
export const DIAL_BREAKER_HEALTHY_MS = 60_000;

export type DialBreakerDecision = {
  allow: boolean;
  cooling: boolean;
  until: number | null;
  failures: number;
  level: number;
};

export type DialBreakerSnapshot = {
  cooling: boolean;
  until: number | null;
  failures: number;
  level: number;
  lastFailureKind: string | null;
};

export type DialBreakerTripEvent = {
  peer: string;
  fails: number;
  level: number;
  cooldownMs: number;
  until: number;
};

export type DialBreakerResetEvent = {
  peer: string;
  healthyMs: number;
};

export type DialBreakerFailureResult = {
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

export type DialBreakerOptions = {
  now?: () => number;
  breakerMs?: number;
  failLimit?: number;
  healthyMs?: number;
  maxMs?: number;
  skipKinds?: ReadonlySet<string>;
  onTrip?: (event: DialBreakerTripEvent) => void;
  onReset?: (event: DialBreakerResetEvent) => void;
  trackAttempts?: boolean;
};

export class DialBreaker {
  private readonly now: () => number;
  private readonly breakerMs: number;
  private readonly failLimit: number;
  private readonly healthyMs: number;
  private readonly maxMs: number;
  private readonly skipKinds: ReadonlySet<string> | undefined;
  private readonly onTrip?: (event: DialBreakerTripEvent) => void;
  private readonly onReset?: (event: DialBreakerResetEvent) => void;
  private readonly trackAttempts: boolean;
  private readonly peers = new Map<string, PeerState>();

  constructor(opts: DialBreakerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.breakerMs = opts.breakerMs ?? DIAL_BREAKER_BASE_MS;
    this.failLimit = opts.failLimit ?? DIAL_BREAKER_FAILS;
    this.healthyMs = opts.healthyMs ?? DIAL_BREAKER_HEALTHY_MS;
    this.maxMs = opts.maxMs ?? DIAL_BREAKER_MAX_MS;
    this.skipKinds = opts.skipKinds;
    this.onTrip = opts.onTrip;
    this.onReset = opts.onReset;
    this.trackAttempts = opts.trackAttempts ?? false;
  }

  shouldTry(peer: string, now = this.now()): DialBreakerDecision {
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

  snapshot(peer: string, now = this.now()): DialBreakerSnapshot {
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
    if (this.trackAttempts) state.activeAttempt = attemptId;
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
  ): DialBreakerFailureResult {
    if (this.skipKinds?.has(kind)) {
      return { counted: false, opened: false, open: false };
    }
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
    if (this.trackAttempts) {
      state.activeAttempt = null;
      state.lastFailureAt = now;
    }
    state.healthySince = null;
    if (this.trackAttempts) state.establishedAttempt = null;
    state.consecutiveFailures += 1;
    state.lastFailureKind = kind;
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
    if (this.trackAttempts) {
      state.activeAttempt = attemptId ?? null;
      state.establishedAttempt = attemptId ?? null;
    }
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

  notePeerChanged(peer: string): void {
    const state = this.peers.get(peer);
    if (state) state.activeAttempt = null;
  }

  remainingCooldownMs(peer: string, now = this.now()): number {
    const until = this.shouldTry(peer, now).until;
    return until == null ? 0 : Math.max(0, until - now);
  }

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
