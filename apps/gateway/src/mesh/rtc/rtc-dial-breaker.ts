import {
  DIAL_BREAKER_BASE_MS,
  DIAL_BREAKER_FAILS,
  DIAL_BREAKER_HEALTHY_MS,
  DIAL_BREAKER_MAX_MS,
  DialBreaker,
  type DialBreakerDecision,
  type DialBreakerFailureResult,
  type DialBreakerHealthProof,
  type DialBreakerResetEvent,
  type DialBreakerSnapshot,
  type DialBreakerTripEvent,
} from '../../../../../packages/shared/src/net/dial-breaker';
import { envInt } from '../mesh-log';
import { AnswerRateLimit } from './rtc-answer-rate';
import {
  type RtcDialFailureOpts,
  classifyRtcDialFailure,
  isIntentionalDcLoss,
  isUncountedPeerInitiatedTimeout,
  rtcDialFailureMetaOf,
} from './rtc-dial-failure';
import {
  type DisabledProbeRow,
  type ProbeJitter,
  RTC_DECLINE_BACKOFF_CAP_MS,
  armOutboundProbe,
  beginOutboundProbe,
  disabledProbeInterval,
  forceProbeJitterMs,
  inboundSlotOpen,
  noteInboundAccepted as markInboundAccepted,
  newDisabledRow,
  noteProbeStrike,
  outboundProbeDueAt,
  refusalBackoff,
} from './rtc-force-probe';
import { flushDialFailed, rtcLog } from './rtc-log';

export {
  ANSWERER_COOLDOWN_MS,
  ANSWERER_TIMEOUT_LIMIT,
  AnswererOfferBackoff,
} from './rtc-answerer-backoff';

export const RTC_DIAL_BREAKER_FAILS = DIAL_BREAKER_FAILS;
export const RTC_DIAL_BREAKER_BASE_MS_DEFAULT = DIAL_BREAKER_BASE_MS;
export const RTC_DIAL_BREAKER_MAX_MS = DIAL_BREAKER_MAX_MS;
export const RTC_DIAL_BREAKER_HEALTHY_MS = DIAL_BREAKER_HEALTHY_MS;
export const RTC_DIAL_DISABLE_AFTER_DEFAULT = 10;
export const RTC_DIAL_FORCE_PROBE_MS = 10 * 60 * 1000;
/** 冷却档位到顶后不再接对端 offer。更低档仍应答，避免短暂失败互相掐断。 */
export const RTC_ANSWER_REFUSE_LEVEL = 5;

export const RTC_DIAL_BREAKER_MS_DEFAULT = RTC_DIAL_BREAKER_BASE_MS_DEFAULT;

export const RTC_DIAL_BREAKER_SKIP_KINDS = new Set(['signaling-state', 'signal-dropped']);

export const DC_FULL_REARM_SOURCES = ['manual', 'local-fingerprint', 'peer-endpoint'] as const;
export const DC_DECAY_REARM_SOURCES = [
  'uplink-url-changed',
  'uplink-switch',
  'presence-return',
  'peer-capabilities',
  'ice-config',
] as const;
export const DC_REARM_SOURCES = [...DC_FULL_REARM_SOURCES, ...DC_DECAY_REARM_SOURCES] as const;
export type DcRearmSource = (typeof DC_REARM_SOURCES)[number];

const DECAY_REARM = new Set<DcRearmSource>(DC_DECAY_REARM_SOURCES);

export type RtcDialBreakerDecision = DialBreakerDecision & {
  disabled: boolean;
  /** 本端 disabled 的 force-probe 窗口（含刚拨出后的握手宽限）开着：入站 offer 不要 decline。 */
  acceptInbound?: boolean;
};
export type RtcDialBreakerSnapshot = DialBreakerSnapshot & { disabled: boolean };
export type RtcDialBreakerTripEvent = DialBreakerTripEvent;
export type RtcDialBreakerResetEvent = DialBreakerResetEvent;
export type RtcDialFailureResult = DialBreakerFailureResult;

export type RtcDialBreakerDisableEvent = {
  peer: string;
  fails: number;
  disableAfter: number;
};

export type RtcDialBreakerRearmEvent = {
  peer: string;
  source: DcRearmSource;
  levelBefore: number;
  levelAfter: number;
};

export type DcOfferBlockReason = 'disabled' | 'cooling';

/** disabled 才按熔断拒绝。冷却到顶不再静默拒答，改由应答限速回 decline。 */
export function inboundOfferBlockReason(
  decision: Pick<RtcDialBreakerDecision, 'disabled' | 'cooling' | 'level'>
): DcOfferBlockReason | null {
  if (decision.disabled) return 'disabled';
  return null;
}

export type { RtcDialFailureOpts } from './rtc-dial-failure';
export {
  classifyRtcDialFailure,
  isIntentionalDcLoss,
  isUncountedDcTrustFailure,
  rtcDialFailureMetaOf,
} from './rtc-dial-failure';

export type RtcDialBreakerOptions = {
  now?: () => number;
  breakerMs?: number;
  failLimit?: number;
  healthyMs?: number;
  maxMs?: number;
  disableAfter?: number;
  forceProbeMs?: number;
  /** 缺省不加抖动。网关工厂使用按对端 id 散列的抖动。 */
  probeJitterMs?: ProbeJitter;
  onTrip?: (event: RtcDialBreakerTripEvent) => void;
  onReset?: (event: RtcDialBreakerResetEvent) => void;
  onDisable?: (event: RtcDialBreakerDisableEvent) => void;
  onRearm?: (event: RtcDialBreakerRearmEvent) => void;
};

export { isSupersededDcLoss } from './rtc-dial-progress';

/** 进程内状态，不落盘；gateway 重启即清零（不必 source=startup rearm）。 */
export class RtcDialBreaker {
  private readonly inner: DialBreaker;
  private readonly now: () => number;
  private readonly disableAfter: number;
  private readonly forceProbeMs: number;
  private readonly jitter: ProbeJitter;
  private readonly onDisable?: (event: RtcDialBreakerDisableEvent) => void;
  private readonly onRearm?: (event: RtcDialBreakerRearmEvent) => void;
  private readonly disabled = new Map<string, DisabledProbeRow>();
  private readonly remoteRefusal = new Map<string, number>();
  /** 应答侧未收到远端 SDP 的 timeout 不抬档，但仍让 snapshot.lastFailureKind 看到本次 kind。 */
  private readonly lastUncountedKind = new Map<string, string>();
  /** 每个对端 30s 最多接一条 offer。 */
  private readonly answerRate: AnswerRateLimit;

  constructor(opts: RtcDialBreakerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.answerRate = new AnswerRateLimit(this.now);
    this.disableAfter =
      opts.disableAfter ??
      envInt('VIBETERM_RTC_DIAL_DISABLE_AFTER', RTC_DIAL_DISABLE_AFTER_DEFAULT, 1);
    this.forceProbeMs = opts.forceProbeMs ?? RTC_DIAL_FORCE_PROBE_MS;
    this.jitter = opts.probeJitterMs ?? (() => 0);
    this.onDisable = opts.onDisable;
    this.onRearm = opts.onRearm;
    this.inner = new DialBreaker({
      now: this.now,
      breakerMs:
        opts.breakerMs ??
        envInt('VIBETERM_RTC_DIAL_BREAKER_MS', RTC_DIAL_BREAKER_BASE_MS_DEFAULT, 1),
      failLimit: opts.failLimit ?? RTC_DIAL_BREAKER_FAILS,
      healthyMs: opts.healthyMs ?? RTC_DIAL_BREAKER_HEALTHY_MS,
      maxMs: opts.maxMs ?? RTC_DIAL_BREAKER_MAX_MS,
      onTrip: opts.onTrip,
      onReset: opts.onReset,
      skipKinds: RTC_DIAL_BREAKER_SKIP_KINDS,
      trackAttempts: true,
      countForeignKinds: new Set([
        'liveness-timeout',
        'channel-closed',
        'missed-pong',
        'no srflx candidates',
        'stun unconfigured',
      ]),
    });
  }

  shouldTry(peer: string, now = this.now()): RtcDialBreakerDecision {
    const row = this.disabled.get(peer);
    if (!row) return { ...this.inner.shouldTry(peer, now), disabled: false, acceptInbound: false };
    const clock = this.probeClock(peer, now);
    const due = armOutboundProbe(row, clock);
    if (due) this.inner.forceProbe(peer);
    const inner = this.inner.shouldTry(peer, now);
    return {
      ...inner,
      allow: due ? inner.allow : false,
      disabled: true,
      acceptInbound: inboundSlotOpen(row, clock),
    };
  }

  outboundProbeDue(peer: string, now = this.now()): boolean {
    const row = this.disabled.get(peer);
    if (!row) return false;
    if (row.probeArmedAt !== null) return true;
    return now >= outboundProbeDueAt(row, this.probeClock(peer, now));
  }

  nextOutboundProbeAt(peer: string, now = this.now()): number | null {
    const row = this.disabled.get(peer);
    if (!row) return null;
    if (row.probeArmedAt !== null) return now;
    return outboundProbeDueAt(row, this.probeClock(peer, now));
  }

  disabledProbeIntervalMs(peer: string): number {
    const row = this.disabled.get(peer);
    if (!row) return this.forceProbeMs;
    return disabledProbeInterval(row, this.forceProbeMs);
  }

  snapshot(peer: string, now?: number): RtcDialBreakerSnapshot {
    const inner = this.inner.snapshot(peer, now);
    return {
      ...inner,
      disabled: this.disabled.has(peer),
      lastFailureKind: this.lastUncountedKind.get(peer) ?? inner.lastFailureKind,
    };
  }

  isDisabled(peer: string): boolean {
    return this.disabled.has(peer);
  }

  /**
   * 应答侧是否还该接这个对端的 offer。
   * disabled 的入站槽内放行。限速窗口内拒绝，但回应本端 reroll-request 可以绕过限速。
   */
  shouldAcceptAnswer(
    peer: string,
    now = this.now(),
    opts?: { respondsToOurRequest?: boolean }
  ): boolean {
    if (this.inboundSlotAllows(peer, now)) return true;
    if (this.disabled.has(peer)) return false;
    if (opts?.respondsToOurRequest === true) return true;
    return !this.answerRate.blocked(peer, now);
  }

  inboundBlock(peer: string, now = this.now()): DcOfferBlockReason | null {
    if (this.inboundSlotAllows(peer, now)) return null;
    if (this.disabled.has(peer)) return 'disabled';
    if (this.answerRate.blocked(peer, now)) return 'cooling';
    return null;
  }

  /** 回给 offerer 的冷却。disabled 用下次入站槽，限速用剩余窗口。 */
  refusalCooldown(peer: string, now = this.now()): { until: number | null; retryAfterMs: number } {
    const rate = this.answerRate.retryAfterMs(peer, now);
    if (rate > 0 && !this.disabled.has(peer)) {
      return { until: now + rate, retryAfterMs: rate };
    }
    return refusalBackoff(this.disabled.get(peer), null, this.probeClock(peer, now));
  }

  noteAnswerAccepted(peer: string, now = this.now()): void {
    this.answerRate.noteAccepted(peer, now);
  }

  escalatedPeers(now = this.now()): string[] {
    const ids = new Set(this.disabled.keys());
    for (const peer of this.inner.peerIds()) {
      const snap = this.inner.snapshot(peer, now);
      if (snap.level > 0 || snap.cooling) ids.add(peer);
    }
    return [...ids];
  }

  noteInboundAccepted(peer: string, now = this.now()): void {
    const row = this.disabled.get(peer);
    if (!row) return;
    markInboundAccepted(row, this.probeClock(peer, now));
  }

  disabledPeers(): string[] {
    return [...this.disabled.keys()];
  }

  beginAttempt(peer: string, attemptId: string): void {
    const row = this.disabled.get(peer);
    if (row) beginOutboundProbe(row, this.now());
    this.inner.beginAttempt(peer, attemptId);
  }

  forceProbe(peer: string): void {
    this.rearmDisabled(peer, 'manual');
    this.inner.forceProbe(peer);
  }

  noteFailure(
    peer: string,
    kind = 'unknown',
    attemptId?: string,
    now?: number,
    opts?: RtcDialFailureOpts
  ): RtcDialFailureResult {
    const classified = classifyRtcDialFailure(kind);
    const breakerKind = RTC_DIAL_BREAKER_SKIP_KINDS.has(classified) ? classified : kind;
    if (
      opts?.reroll === true ||
      opts?.peerInitiated === true ||
      isUncountedPeerInitiatedTimeout(classified, opts)
    ) {
      if (opts?.peerInitiated === true) this.answerRate.reset(peer);
      this.lastUncountedKind.set(peer, breakerKind);
      const decision = this.inner.shouldTry(peer, now);
      return {
        counted: false,
        opened: false,
        open: decision.cooling,
        until: decision.until ?? undefined,
      };
    }
    this.lastUncountedKind.delete(peer);
    const result = this.inner.noteFailure(peer, breakerKind, attemptId, now);
    if (result.counted) {
      this.remoteRefusal.delete(peer);
      this.maybeDisable(peer, now);
    }
    return result;
  }

  noteChannelEstablished(peer: string, attemptId?: string, now?: number): void {
    // 建连不等于稳住。disabled 只在 noteHealthy 活过 healthyMs 之后解除。
    this.lastUncountedKind.delete(peer);
    this.answerRate.reset(peer);
    this.inner.noteChannelEstablished(peer, attemptId, now);
  }

  /** 已建立的那条 DC 拆了。外尝试护盾随之结束，之后的拨号失败重新计数。 */
  noteChannelLost(peer: string, attemptId?: string): void {
    this.inner.noteChannelLost(peer, attemptId);
  }

  /** 对端 decline 的冷却还没到期。上行切换不能把它清掉。过期的记录不再挡住后续熔断冷却。 */
  honoursRemoteRefusal(peer: string, now = this.now()): boolean {
    const until = this.remoteRefusal.get(peer) ?? 0;
    if (until <= now) return false;
    return this.inner.shouldTry(peer, now).cooling;
  }

  noteUnstable(peer: string, cooldownMs: number, now?: number): void {
    this.inner.noteUnstable(peer, cooldownMs, now);
  }

  /** 对端 decline 带来的冷却：不升档、不计失败，也不解除 disabled。超过 30min 的直到被夹掉。 */
  noteRemoteRefusal(peer: string, until: number | null, now = this.now()): void {
    if (until == null || !Number.isFinite(until) || until <= now) return;
    const capped = Math.min(until, now + RTC_DECLINE_BACKOFF_CAP_MS);
    const next = Math.max(this.remoteRefusal.get(peer) ?? 0, capped);
    this.remoteRefusal.set(peer, next);
    this.inner.noteCooldownUntil(peer, next);
  }

  noteHealthy(peer: string, now?: number, proof?: DialBreakerHealthProof): boolean {
    const reset = this.inner.noteHealthy(peer, now, proof);
    if (reset) this.disabled.delete(peer);
    this.remoteRefusal.delete(peer);
    this.lastUncountedKind.delete(peer);
    this.answerRate.reset(peer);
    return reset;
  }

  rearmDisabled(peer: string, source: DcRearmSource): boolean {
    if (DECAY_REARM.has(source)) return this.decayPeer(peer, source);
    const softened = this.clearSoftCooldown(peer);
    if (!this.disabled.has(peer)) return softened;
    const levelBefore = this.inner.snapshot(peer).level;
    this.disabled.delete(peer);
    this.remoteRefusal.delete(peer);
    this.answerRate.reset(peer);
    this.inner.reset(peer);
    this.onRearm?.({ peer, source, levelBefore, levelAfter: 0 });
    return true;
  }

  /** 只清 unstable-dc。对端 decline 的 retryAfter 留下，由对方说了算。 */
  clearUnstableCooldowns(): string[] {
    return this.inner.clearUnstableCooling();
  }

  rearmAllDisabled(source: DcRearmSource): string[] {
    const peers = this.disabledPeers();
    const rearmed: string[] = [];
    for (const peer of peers) {
      if (this.rearmDisabled(peer, source)) rearmed.push(peer);
    }
    return rearmed;
  }

  reset(peer?: string): void {
    if (peer) {
      this.disabled.delete(peer);
      this.remoteRefusal.delete(peer);
      this.lastUncountedKind.delete(peer);
    } else {
      this.disabled.clear();
      this.remoteRefusal.clear();
      this.lastUncountedKind.clear();
    }
    this.answerRate.reset(peer);
    this.inner.reset(peer);
  }

  private decayPeer(peer: string, source: DcRearmSource): boolean {
    const snap = this.snapshot(peer);
    if (!snap.disabled && !snap.cooling && snap.level <= 0) return false;
    const levelBefore = snap.level;
    const keepRefusal = this.keepsRemoteRefusal(source, peer);
    const stored = keepRefusal ? this.remoteRefusal.get(peer) : undefined;
    const refusalUntil = stored != null && stored > this.now() ? stored : null;
    this.disabled.delete(peer);
    if (refusalUntil == null) this.remoteRefusal.delete(peer);
    const levelAfter = this.inner.decayEscalation(peer)?.levelAfter ?? levelBefore;
    if (refusalUntil != null) this.inner.noteCooldownUntil(peer, refusalUntil);
    this.answerRate.reset(peer);
    this.onRearm?.({ peer, source, levelBefore, levelAfter });
    return true;
  }

  private keepsRemoteRefusal(source: DcRearmSource, peer: string): boolean {
    if (source !== 'uplink-url-changed' && source !== 'uplink-switch') return false;
    return this.remoteRefusal.has(peer);
  }

  private inboundSlotAllows(peer: string, now: number): boolean {
    const row = this.disabled.get(peer);
    return !!row && inboundSlotOpen(row, this.probeClock(peer, now));
  }

  private maybeDisable(peer: string, now?: number): void {
    const at = now ?? this.now();
    const row = this.disabled.get(peer);
    if (row) {
      noteProbeStrike(row);
      return;
    }
    const failures = this.inner.snapshot(peer, now).failures;
    if (failures < this.disableAfter) return;
    this.disabled.set(peer, newDisabledRow(at));
    this.onDisable?.({ peer, fails: failures, disableAfter: this.disableAfter });
  }

  private clearSoftCooldown(peer: string): boolean {
    const refusal = this.remoteRefusal.delete(peer);
    const unstable = this.inner.snapshot(peer).lastFailureKind === 'unstable-dc';
    if (!refusal && !unstable) return false;
    this.inner.clearCooling(peer, { dropUnstableKind: unstable });
    return true;
  }

  private probeClock(peer: string, now: number) {
    return { now, baseMs: this.forceProbeMs, jitter: this.jitter, peer };
  }
}

export function createGatewayRtcDialBreaker(opts: RtcDialBreakerOptions = {}): RtcDialBreaker {
  return new RtcDialBreaker({
    probeJitterMs: forceProbeJitterMs,
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
    onDisable: (event) => {
      opts.onDisable?.(event);
      rtcLog('breaker disabled', {
        peer: event.peer,
        fails: event.fails,
        disable_after: event.disableAfter,
      });
    },
    onRearm: (event) => {
      opts.onRearm?.(event);
      rtcLog('breaker rearm', {
        peer: event.peer,
        source: event.source,
        level_before: event.levelBefore,
        level_after: event.levelAfter,
      });
    },
  });
}
