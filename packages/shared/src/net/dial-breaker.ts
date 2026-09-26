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
  lastCountedAttempt: string | null;
  establishedAttempt: string | null;
  forceProbe: boolean;
};

export type DialBreakerHealthProof = {
  ageMs: number;
  proven: boolean;
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
  /** 这些 kind 即使不是当前 established attempt 也要记进主熔断（活链路自己死了）。 */
  countForeignKinds?: ReadonlySet<string>;
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
  private readonly countForeignKinds: ReadonlySet<string> | undefined;
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
    this.countForeignKinds = opts.countForeignKinds;
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

  beginAttempt(peer: string, _attemptId: string): void {
    const state = this.ensure(peer);
    if (state.forceProbe) state.forceProbe = false;
  }

  peerIds(): string[] {
    return [...this.peers.keys()];
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
    if (this.foreignEstablishedAttempt(state, attemptId) && !this.countForeignKinds?.has(kind)) {
      return {
        counted: false,
        opened: false,
        open: state.coolingUntil > now,
        until: state.coolingUntil > now ? state.coolingUntil : undefined,
      };
    }
    if (attemptId) state.lastCountedAttempt = attemptId;
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
    if (this.trackAttempts) state.establishedAttempt = attemptId ?? null;
    state.healthySince = now;
  }

  /**
   * 这条已建立的 DC 不再是活链路。外尝试护盾只覆盖它还活着的时候，
   * 否则后续超时永远不计，熔断升不了档。
   */
  noteChannelLost(peer: string, attemptId?: string): void {
    if (!this.trackAttempts) return;
    const state = this.peers.get(peer);
    if (!state?.establishedAttempt) return;
    if (attemptId && state.establishedAttempt !== attemptId) return;
    state.establishedAttempt = null;
  }

  /** 已建立但未证明的 DC 反复夭折：短冷却，不抬 consecutiveFailures / level。 */
  noteUnstable(peer: string, cooldownMs: number, now = this.now()): void {
    if (cooldownMs <= 0) return;
    const state = this.ensure(peer);
    const until = now + cooldownMs;
    if (until > state.coolingUntil) state.coolingUntil = until;
    state.healthySince = null;
    state.lastFailureKind = 'unstable-dc';
  }

  /** 对端拒绝：只把冷却终点延后。不升档、不计失败、不改失败种类。 */
  noteCooldownUntil(peer: string, until: number): void {
    if (!(until > 0)) return;
    const state = this.ensure(peer);
    if (until > state.coolingUntil) state.coolingUntil = until;
  }

  /** 只清冷却终点。unstable-dc 可以连失败种类一起清。不改 level / failures。 */
  clearCooling(peer: string, opts?: { dropUnstableKind?: boolean }): void {
    const state = this.peers.get(peer);
    if (!state) return;
    state.coolingUntil = 0;
    if (opts?.dropUnstableKind && state.lastFailureKind === 'unstable-dc') {
      state.lastFailureKind = null;
    }
  }

  clearUnstableCooling(): string[] {
    const cleared: string[] = [];
    for (const [peer, state] of this.peers) {
      if (state.lastFailureKind !== 'unstable-dc') continue;
      state.coolingUntil = 0;
      state.lastFailureKind = null;
      cleared.push(peer);
    }
    return cleared;
  }

  noteHealthy(peer: string, now = this.now(), proof?: DialBreakerHealthProof): boolean {
    const state = this.peers.get(peer);
    if (!state) return false;
    if (proof) {
      if (!proof.proven || proof.ageMs < this.healthyMs) return false;
      return this.clearDebt(state, peer, proof.ageMs);
    }
    if (state.healthySince == null) return false;
    const healthyMs = Math.max(0, now - state.healthySince);
    if (healthyMs < this.healthyMs) return false;
    return this.clearDebt(state, peer, healthyMs);
  }

  remainingCooldownMs(peer: string, now = this.now()): number {
    const until = this.shouldTry(peer, now).until;
    return until == null ? 0 : Math.max(0, until - now);
  }

  reset(peer?: string): void {
    if (peer) this.peers.delete(peer);
    else this.peers.clear();
  }

  /**
   * 降一档并结束当前冷却，保留失败次数。不删除 peer。
   * relay 熔断继续只用 reset()，语义不变。
   */
  decayEscalation(peer: string): { levelBefore: number; levelAfter: number } | null {
    const state = this.peers.get(peer);
    if (!state) return null;
    const levelBefore = state.cooldownLevel;
    const levelAfter = Math.max(0, state.cooldownLevel - 1);
    state.cooldownLevel = levelAfter;
    state.coolingUntil = 0;
    state.forceProbe = false;
    return { levelBefore, levelAfter };
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
        establishedAttempt: null,
        forceProbe: false,
      };
      this.peers.set(peer, state);
    }
    return state;
  }

  private foreignEstablishedAttempt(state: PeerState, attemptId?: string): boolean {
    return (
      this.trackAttempts &&
      !!attemptId &&
      !!state.establishedAttempt &&
      attemptId !== state.establishedAttempt
    );
  }

  private clearDebt(state: PeerState, peer: string, healthyMs: number): boolean {
    const hadDebt =
      state.consecutiveFailures > 0 || state.cooldownLevel > 0 || state.coolingUntil > 0;
    state.consecutiveFailures = 0;
    state.cooldownLevel = 0;
    state.coolingUntil = 0;
    state.lastFailureKind = null;
    state.forceProbe = false;
    state.lastCountedAttempt = null;
    if (hadDebt) this.onReset?.({ peer, healthyMs });
    return hadDebt;
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
