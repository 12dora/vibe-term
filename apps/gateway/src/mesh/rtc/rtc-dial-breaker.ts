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
import { flushDialFailed, rtcLog } from './rtc-log';

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

  constructor(opts: RtcDialBreakerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.disableAfter =
      opts.disableAfter ?? envInt('TMEX_RTC_DIAL_DISABLE_AFTER', RTC_DIAL_DISABLE_AFTER_DEFAULT, 1);
    this.forceProbeMs = opts.forceProbeMs ?? RTC_DIAL_FORCE_PROBE_MS;
    this.onDisable = opts.onDisable;
    this.onRearm = opts.onRearm;
    this.inner = new DialBreaker({
      now: this.now,
      breakerMs:
        opts.breakerMs ?? envInt('TMEX_RTC_DIAL_BREAKER_MS', RTC_DIAL_BREAKER_BASE_MS_DEFAULT, 1),
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
    return { ...inner, disabled: this.disabled.has(peer) };
  }

  isDisabled(peer: string): boolean {
    return this.disabled.has(peer);
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
    now?: number
  ): RtcDialFailureResult {
    const classified = classifyRtcDialFailure(kind);
    const breakerKind = RTC_DIAL_BREAKER_SKIP_KINDS.has(classified) ? classified : kind;
    const result = this.inner.noteFailure(peer, breakerKind, attemptId, now);
    if (result.counted) this.maybeDisable(peer, now);
    return result;
  }

  noteChannelEstablished(peer: string, attemptId?: string, now?: number): void {
    this.disabled.delete(peer);
    this.inner.noteChannelEstablished(peer, attemptId, now);
  }

  noteHealthy(peer: string, now?: number): boolean {
    this.disabled.delete(peer);
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
    if (peer) this.disabled.delete(peer);
    else this.disabled.clear();
    this.inner.reset(peer);
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
