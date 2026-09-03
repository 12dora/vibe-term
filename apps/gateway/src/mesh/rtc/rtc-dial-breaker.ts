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

export const RTC_DIAL_BREAKER_MS_DEFAULT = RTC_DIAL_BREAKER_BASE_MS_DEFAULT;

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
  private readonly inner: DialBreaker;
  private readonly disableAfter: number;
  private readonly onDisable?: (event: RtcDialBreakerDisableEvent) => void;
  private readonly onRearm?: (event: RtcDialBreakerRearmEvent) => void;
  private readonly disabled = new Set<string>();

  constructor(opts: RtcDialBreakerOptions = {}) {
    this.disableAfter =
      opts.disableAfter ?? envInt('TMEX_RTC_DIAL_DISABLE_AFTER', RTC_DIAL_DISABLE_AFTER_DEFAULT, 1);
    this.onDisable = opts.onDisable;
    this.onRearm = opts.onRearm;
    this.inner = new DialBreaker({
      now: opts.now,
      breakerMs:
        opts.breakerMs ?? envInt('TMEX_RTC_DIAL_BREAKER_MS', RTC_DIAL_BREAKER_BASE_MS_DEFAULT, 1),
      failLimit: opts.failLimit ?? RTC_DIAL_BREAKER_FAILS,
      healthyMs: opts.healthyMs ?? RTC_DIAL_BREAKER_HEALTHY_MS,
      maxMs: opts.maxMs ?? RTC_DIAL_BREAKER_MAX_MS,
      onTrip: opts.onTrip,
      onReset: opts.onReset,
      trackAttempts: true,
    });
  }

  shouldTry(peer: string, now?: number): RtcDialBreakerDecision {
    const inner = this.inner.shouldTry(peer, now);
    const disabled = this.disabled.has(peer);
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
    return [...this.disabled];
  }

  beginAttempt(peer: string, attemptId: string): void {
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
    const result = this.inner.noteFailure(peer, kind, attemptId, now);
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
    this.disabled.add(peer);
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
