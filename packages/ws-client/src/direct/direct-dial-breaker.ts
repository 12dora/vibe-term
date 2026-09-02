export const DIRECT_DIAL_BREAKER_FAILS = 3;
export const DIRECT_DIAL_BREAKER_BASE_MS = 30_000;
export const DIRECT_DIAL_BREAKER_MAX_MS = 30 * 60 * 1000;
export const DIRECT_DIAL_BREAKER_HEALTHY_MS = 60_000;

export type DirectDialBreakerDecision = {
  allow: boolean;
  cooling: boolean;
  until: number | null;
  failures: number;
  level: number;
};

export type DirectDialBreakerSnapshot = {
  cooling: boolean;
  until: number | null;
  failures: number;
  level: number;
  lastFailureKind: string | null;
};

type PeerState = {
  consecutiveFailures: number;
  cooldownLevel: number;
  coolingUntil: number;
  healthySince: number | null;
  lastFailureKind: string | null;
  lastCountedAttempt: string | null;
  forceProbe: boolean;
};

export type DirectDialBreakerOptions = {
  now?: () => number;
  breakerMs?: number;
  failLimit?: number;
  healthyMs?: number;
  maxMs?: number;
};

const SKIP_KINDS = new Set(['signaling-not-ready', 'primary-wait']);

export function classifyDirectDialFailure(reason: string | null | undefined): string | null {
  if (!reason) return 'unknown';
  const r = reason.toLowerCase();
  if (r.includes('signaling not ready')) return null;
  if (r.includes('no_connection') || r.includes('multiple_connections')) return null;
  if (r.includes('authoriz')) return 'authorization';
  if (r.includes('fingerprint')) return 'fingerprint';
  if (r.includes('timeout') || r.includes('timed out')) return 'timeout';
  if (r.includes('ice')) return 'ice';
  if (r.includes('protocol')) return 'protocol';
  if (r.includes('carrier') || r.includes('switched back')) return 'carrier';
  if (r.includes('channel') || r.includes('datachannel')) return 'channel';
  return reason.length > 64 ? reason.slice(0, 64) : reason;
}

export class DirectDialBreaker {
  private readonly now: () => number;
  private readonly breakerMs: number;
  private readonly failLimit: number;
  private readonly healthyMs: number;
  private readonly maxMs: number;
  private readonly peers = new Map<string, PeerState>();

  constructor(opts: DirectDialBreakerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.breakerMs = opts.breakerMs ?? DIRECT_DIAL_BREAKER_BASE_MS;
    this.failLimit = opts.failLimit ?? DIRECT_DIAL_BREAKER_FAILS;
    this.healthyMs = opts.healthyMs ?? DIRECT_DIAL_BREAKER_HEALTHY_MS;
    this.maxMs = opts.maxMs ?? DIRECT_DIAL_BREAKER_MAX_MS;
  }

  shouldTry(peer: string, now = this.now()): DirectDialBreakerDecision {
    const state = this.peers.get(peer);
    if (!state) {
      return { allow: true, cooling: false, until: null, failures: 0, level: 0 };
    }
    const cooling = state.coolingUntil > now;
    return {
      allow: !cooling || state.forceProbe,
      cooling,
      until: cooling ? state.coolingUntil : null,
      failures: state.consecutiveFailures,
      level: state.cooldownLevel,
    };
  }

  snapshot(peer: string, now = this.now()): DirectDialBreakerSnapshot {
    const decision = this.shouldTry(peer, now);
    return {
      cooling: decision.cooling,
      until: decision.until,
      failures: decision.failures,
      level: decision.level,
      lastFailureKind: this.peers.get(peer)?.lastFailureKind ?? null,
    };
  }

  beginAttempt(peer: string, attemptId: string): void {
    const state = this.ensure(peer);
    if (state.forceProbe) state.forceProbe = false;
    void attemptId;
  }

  forceProbe(peer: string): void {
    this.ensure(peer).forceProbe = true;
  }

  noteFailure(peer: string, kind: string, attemptId?: string, now = this.now()): boolean {
    if (SKIP_KINDS.has(kind) || kind === '') return false;
    const state = this.ensure(peer);
    if (attemptId && state.lastCountedAttempt === attemptId) return false;
    if (attemptId) state.lastCountedAttempt = attemptId;
    state.healthySince = null;
    state.consecutiveFailures += 1;
    state.lastFailureKind = kind;
    if (state.coolingUntil > now) return true;
    if (state.consecutiveFailures < this.failLimit) return true;
    const cooldownMs = Math.min(this.maxMs, this.breakerMs * 2 ** state.cooldownLevel);
    state.coolingUntil = now + Math.max(1, cooldownMs);
    state.cooldownLevel = Math.min(state.cooldownLevel + 1, this.maxLevel());
    return true;
  }

  noteChannelEstablished(peer: string, attemptId?: string, now = this.now()): void {
    const state = this.ensure(peer);
    if (attemptId && state.lastCountedAttempt === attemptId) return;
    state.healthySince = now;
  }

  noteHealthy(peer: string, now = this.now()): boolean {
    const state = this.peers.get(peer);
    if (!state || state.healthySince == null) return false;
    if (now - state.healthySince < this.healthyMs) return false;
    const hadDebt =
      state.consecutiveFailures > 0 || state.cooldownLevel > 0 || state.coolingUntil > 0;
    state.consecutiveFailures = 0;
    state.cooldownLevel = 0;
    state.coolingUntil = 0;
    state.lastFailureKind = null;
    state.forceProbe = false;
    state.lastCountedAttempt = null;
    return hadDebt;
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
        lastCountedAttempt: null,
        forceProbe: false,
      };
      this.peers.set(peer, state);
    }
    return state;
  }

  private maxLevel(): number {
    if (this.breakerMs >= this.maxMs) return 0;
    let level = 0;
    while (this.breakerMs * 2 ** (level + 1) <= this.maxMs) level += 1;
    return level;
  }
}
