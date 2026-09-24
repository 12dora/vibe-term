import {
  type KeywordRule,
  classifyByKeywords,
  truncateReason,
} from '../../../../../packages/shared/src/net/classify-by-keywords';
import {
  DIAL_BREAKER_BASE_MS,
  DIAL_BREAKER_FAILS,
  DIAL_BREAKER_HEALTHY_MS,
  DIAL_BREAKER_MAX_MS,
  DialBreaker,
  type DialBreakerDecision,
  type DialBreakerFailureResult,
  type DialBreakerResetEvent,
  type DialBreakerSnapshot,
  type DialBreakerTripEvent,
} from '../../../../../packages/shared/src/net/dial-breaker';
import { envInt } from '../mesh-log';
import { AnswererOfferBackoff } from './rtc-answerer-backoff';
import type { RtcFailureStage } from './rtc-dial-progress';
import {
  type DisabledProbeRow,
  RTC_FORCE_PROBE_INBOUND_GRACE_MS,
  forceProbeAcceptOpen,
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

export const DC_FULL_REARM_SOURCES = [
  'local-fingerprint',
  'peer-endpoint',
  'uplink-switch',
  'peer-capabilities',
  'manual',
] as const;
export const DC_REARM_SOURCES = [...DC_FULL_REARM_SOURCES, 'presence-return'] as const;
export type DcRearmSource = (typeof DC_REARM_SOURCES)[number];

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

/** disabled，或冷却档位到顶：不应再接对端 offer。 */
export function inboundOfferBlockReason(
  decision: Pick<RtcDialBreakerDecision, 'disabled' | 'cooling' | 'level'>
): DcOfferBlockReason | null {
  if (decision.disabled) return 'disabled';
  if (decision.cooling && decision.level >= RTC_ANSWER_REFUSE_LEVEL) return 'cooling';
  return null;
}

export type RtcDialFailureOpts = {
  peerInitiated?: boolean;
  stage?: RtcFailureStage;
  remoteSdpApplied?: boolean;
};

const RTC_FAILURE_STAGES: ReadonlySet<RtcFailureStage> = new Set([
  'gathering',
  'no-remote-sdp',
  'checking',
  'dtls',
  'handshake',
]);

function isRtcFailureStage(value: unknown): value is RtcFailureStage {
  return typeof value === 'string' && RTC_FAILURE_STAGES.has(value as RtcFailureStage);
}

export function rtcDialFailureMetaOf(err: unknown): {
  reason: string;
  stage?: RtcFailureStage;
  remoteSdpApplied?: boolean;
} {
  const reason = err instanceof Error ? err.message : String(err);
  if (!err || typeof err !== 'object') return { reason };
  const rec = err as { stage?: unknown; remoteSdpApplied?: unknown };
  return {
    reason,
    stage: isRtcFailureStage(rec.stage) ? rec.stage : undefined,
    remoteSdpApplied: typeof rec.remoteSdpApplied === 'boolean' ? rec.remoteSdpApplied : undefined,
  };
}

/** 应答侧没等到远端 SDP 的 timeout 不算本端故障；SDP 已应用后的 dtls/handshake 超时照常计数。 */
export function isUncountedPeerInitiatedTimeout(
  classified: string,
  opts?: RtcDialFailureOpts
): boolean {
  if (opts?.peerInitiated !== true || classified !== 'timeout') return false;
  if (opts.remoteSdpApplied === true) return false;
  return (
    opts.remoteSdpApplied === false || opts.stage === 'gathering' || opts.stage === 'no-remote-sdp'
  );
}

export type RtcDialBreakerOptions = {
  now?: () => number;
  breakerMs?: number;
  failLimit?: number;
  healthyMs?: number;
  maxMs?: number;
  disableAfter?: number;
  forceProbeMs?: number;
  onTrip?: (event: RtcDialBreakerTripEvent) => void;
  onReset?: (event: RtcDialBreakerResetEvent) => void;
  onDisable?: (event: RtcDialBreakerDisableEvent) => void;
  onRearm?: (event: RtcDialBreakerRearmEvent) => void;
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
  'superseded',
  'dc-declined',
  'dc-promote-reject',
  'route-measure-reject',
]);

const RTC_DIAL_FAILURE_RULES: ReadonlyArray<KeywordRule<string>> = [
  [['signal dropped'], 'signal-dropped'],
  [['liveness'], 'liveness-timeout'],
  [['missed-pong', 'missed pong'], 'missed-pong'],
  [['timeout', 'timed out'], 'timeout'],
  [['ice'], 'ice'],
  [['abort'], 'abort'],
  [['fingerprint', 'protocol', 'handshake', 'fragment'], 'protocol'],
  [['channel-error', 'datachannel error'], 'channel-error'],
  [['channel-closed', 'datachannel closed', 'channel closed'], 'channel-closed'],
  [['transport'], 'transport-lost'],
];

export function isIntentionalDcLoss(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return INTENTIONAL_DC_LOSS.has(reason);
}

export { isSupersededDcLoss } from './rtc-dial-progress';

export function classifyRtcDialFailure(reason: string | null | undefined): string {
  if (!reason) return 'unknown';
  const lower = reason.toLowerCase();
  if (lower.includes('unexpected remote') && lower.includes('signaling state')) {
    return 'signaling-state';
  }
  return classifyByKeywords(lower, RTC_DIAL_FAILURE_RULES, (normalized) =>
    normalized === 'closed' ? 'channel-closed' : truncateReason(reason)
  );
}

/** 进程内状态，不落盘；gateway 重启即清零（不必 source=startup rearm）。 */
export class RtcDialBreaker {
  private readonly inner: DialBreaker;
  private readonly now: () => number;
  private readonly disableAfter: number;
  private readonly forceProbeMs: number;
  private readonly onDisable?: (event: RtcDialBreakerDisableEvent) => void;
  private readonly onRearm?: (event: RtcDialBreakerRearmEvent) => void;
  private readonly disabled = new Map<string, DisabledProbeRow>();
  /** 应答侧未收到远端 SDP 的 timeout 不抬档，但仍让 snapshot.lastFailureKind 看到本次 kind。 */
  private readonly lastUncountedKind = new Map<string, string>();
  /** 对端发起的连续超时：忽略该对端后续 offer，不抬 offerer 熔断。 */
  private readonly answererBackoff: AnswererOfferBackoff;

  constructor(opts: RtcDialBreakerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.answererBackoff = new AnswererOfferBackoff(this.now);
    this.disableAfter =
      opts.disableAfter ??
      envInt('VIBETERM_RTC_DIAL_DISABLE_AFTER', RTC_DIAL_DISABLE_AFTER_DEFAULT, 1);
    this.forceProbeMs = opts.forceProbeMs ?? RTC_DIAL_FORCE_PROBE_MS;
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
    });
  }

  shouldTry(peer: string, now = this.now()): RtcDialBreakerDecision {
    let inner = this.inner.shouldTry(peer, now);
    const row = this.disabled.get(peer);
    if (row && (row.probeArmedAt !== null || now - row.lastProbeAt >= this.forceProbeMs)) {
      if (row.probeArmedAt === null) {
        row.probeArmedAt = now;
        this.inner.forceProbe(peer);
      }
      inner = this.inner.shouldTry(peer, now);
      return { ...inner, disabled: true, acceptInbound: true };
    }
    if (row) {
      return {
        ...inner,
        allow: false,
        disabled: true,
        acceptInbound: now < row.inboundOpenUntil,
      };
    }
    return { ...inner, disabled: false, acceptInbound: false };
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
   * disabled 的 force-probe 窗口（含握手宽限）内放行；否则 disabled 或冷却到顶拒绝，reroll 也不能绕过。
   * 仅 answerer backoff 时，对端在应答本端 `link.reroll-request` 仍放行。
   */
  shouldAcceptAnswer(
    peer: string,
    now = this.now(),
    opts?: { respondsToOurRequest?: boolean }
  ): boolean {
    const row = this.disabled.get(peer);
    if (row && forceProbeAcceptOpen(row, now, this.forceProbeMs)) return true;
    if (inboundOfferBlockReason(this.snapshot(peer, now))) return false;
    if (opts?.respondsToOurRequest === true) return true;
    return this.answererBackoff.shouldAccept(peer, now);
  }

  inboundBlock(peer: string, now = this.now()): DcOfferBlockReason | null {
    const row = this.disabled.get(peer);
    if (row && forceProbeAcceptOpen(row, now, this.forceProbeMs)) return null;
    return inboundOfferBlockReason(this.snapshot(peer, now));
  }

  /** 回给 offerer 的冷却。disabled 用下次 force-probe，冷却到顶用 coolingUntil。 */
  refusalCooldown(peer: string, now = this.now()): { until: number | null; retryAfterMs: number } {
    const snap = this.inner.snapshot(peer, now);
    const coolingUntil = snap.cooling && snap.level >= RTC_ANSWER_REFUSE_LEVEL ? snap.until : null;
    return refusalBackoff(this.disabled.get(peer), coolingUntil, now, this.forceProbeMs);
  }

  disabledPeers(): string[] {
    return [...this.disabled.keys()];
  }

  beginAttempt(peer: string, attemptId: string): void {
    const row = this.disabled.get(peer);
    if (row) {
      row.lastProbeAt = row.probeArmedAt ?? this.now();
      row.probeArmedAt = null;
      row.inboundOpenUntil = this.now() + RTC_FORCE_PROBE_INBOUND_GRACE_MS;
    }
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
    if (opts?.peerInitiated === true && classified === 'timeout') {
      this.noteAnswererTimeout(peer, now);
    }
    if (isUncountedPeerInitiatedTimeout(classified, opts)) {
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
    if (result.counted) this.maybeDisable(peer, now);
    return result;
  }

  noteChannelEstablished(peer: string, attemptId?: string, now?: number): void {
    // 建连不等于稳住。disabled 只在 noteHealthy 活过 healthyMs 之后解除。
    this.lastUncountedKind.delete(peer);
    this.answererBackoff.noteSuccess(peer);
    this.inner.noteChannelEstablished(peer, attemptId, now);
  }

  noteUnstable(peer: string, cooldownMs: number, now?: number): void {
    this.inner.noteUnstable(peer, cooldownMs, now);
  }

  /** 对端 decline 带来的冷却：不升档、不计失败，也不解除 disabled。 */
  noteRemoteRefusal(peer: string, until: number | null, now = this.now()): void {
    if (until == null || until <= now) return;
    this.inner.noteCooldownUntil(peer, until);
  }

  noteHealthy(peer: string, now?: number): boolean {
    const reset = this.inner.noteHealthy(peer, now);
    if (reset) this.disabled.delete(peer);
    this.lastUncountedKind.delete(peer);
    this.answererBackoff.noteSuccess(peer);
    return reset;
  }

  notePeerChanged(peer: string): void {
    this.inner.notePeerChanged(peer);
  }

  rearmDisabled(peer: string, source: DcRearmSource): boolean {
    if (source === 'presence-return') return this.notePresenceReturn(peer);
    if (!this.disabled.has(peer)) return false;
    const levelBefore = this.inner.snapshot(peer).level;
    this.disabled.delete(peer);
    this.inner.reset(peer);
    this.onRearm?.({ peer, source, levelBefore, levelAfter: 0 });
    return true;
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
      this.lastUncountedKind.delete(peer);
    } else {
      this.disabled.clear();
      this.lastUncountedKind.clear();
    }
    this.answererBackoff.reset(peer);
    this.inner.reset(peer);
  }

  private notePresenceReturn(peer: string): boolean {
    const snap = this.snapshot(peer);
    if (!snap.disabled && !snap.cooling && snap.level <= 0) return false;
    const levelBefore = snap.level;
    this.disabled.delete(peer);
    const levelAfter = this.inner.decayEscalation(peer)?.levelAfter ?? levelBefore;
    this.onRearm?.({ peer, source: 'presence-return', levelBefore, levelAfter });
    return true;
  }

  private noteAnswererTimeout(peer: string, now?: number): void {
    const trip = this.answererBackoff.noteTimeout(peer, now ?? this.now());
    if (!trip.opened) return;
    rtcLog('answerer_backoff', {
      peer,
      cooldown_ms: trip.cooldownMs,
      consecutive: trip.consecutive,
    });
  }

  private maybeDisable(peer: string, now?: number): void {
    if (this.disabled.has(peer)) return;
    const failures = this.inner.snapshot(peer, now).failures;
    if (failures < this.disableAfter) return;
    this.disabled.set(peer, {
      lastProbeAt: now ?? this.now(),
      probeArmedAt: null,
      inboundOpenUntil: 0,
    });
    this.onDisable?.({ peer, fails: failures, disableAfter: this.disableAfter });
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
