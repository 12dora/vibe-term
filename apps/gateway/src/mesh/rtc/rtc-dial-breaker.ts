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

export const RTC_DIAL_BREAKER_MS_DEFAULT = RTC_DIAL_BREAKER_BASE_MS_DEFAULT;

export const RTC_DIAL_BREAKER_SKIP_KINDS = new Set(['signaling-state', 'signal-dropped']);

export const DC_REARM_SOURCES = [
  'local-fingerprint',
  'peer-endpoint',
  'hub-switch',
  'peer-reconnect',
  'manual',
] as const;
export type DcRearmSource = (typeof DC_REARM_SOURCES)[number];

export type RtcDialBreakerDecision = DialBreakerDecision & { disabled: boolean };
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
};

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
  private readonly disabled = new Map<
    string,
    { lastProbeAt: number; probeArmedAt: number | null }
  >();
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
    const disabled = this.disabled.get(peer);
    if (
      disabled &&
      (disabled.probeArmedAt !== null || now - disabled.lastProbeAt >= this.forceProbeMs)
    ) {
      if (disabled.probeArmedAt === null) {
        disabled.probeArmedAt = now;
        this.inner.forceProbe(peer);
      }
      inner = this.inner.shouldTry(peer, now);
      return { ...inner, disabled: true };
    }
    if (disabled) {
      return { ...inner, allow: false, disabled: true };
    }
    return { ...inner, disabled: false };
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

  /** 应答侧是否还该接这个对端的 offer。冷却中为 false。 */
  shouldAcceptAnswer(peer: string, now = this.now()): boolean {
    return this.answererBackoff.shouldAccept(peer, now);
  }

  disabledPeers(): string[] {
    return [...this.disabled.keys()];
  }

  beginAttempt(peer: string, attemptId: string): void {
    const disabled = this.disabled.get(peer);
    if (disabled) {
      disabled.lastProbeAt = disabled.probeArmedAt ?? this.now();
      disabled.probeArmedAt = null;
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
    this.disabled.delete(peer);
    this.lastUncountedKind.delete(peer);
    this.answererBackoff.noteSuccess(peer);
    this.inner.noteChannelEstablished(peer, attemptId, now);
  }

  noteHealthy(peer: string, now?: number): boolean {
    this.disabled.delete(peer);
    this.lastUncountedKind.delete(peer);
    this.answererBackoff.noteSuccess(peer);
    return this.inner.noteHealthy(peer, now);
  }

  notePeerChanged(peer: string): void {
    this.inner.notePeerChanged(peer);
  }

  rearmDisabled(peer: string, source: DcRearmSource): boolean {
    if (!this.disabled.has(peer)) return false;
    this.disabled.delete(peer);
    this.inner.reset(peer);
    this.onRearm?.({ peer, source });
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
    this.disabled.set(peer, { lastProbeAt: now ?? this.now(), probeArmedAt: null });
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
      });
    },
  });
}
