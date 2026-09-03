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

export const RTC_DIAL_BREAKER_MS_DEFAULT = RTC_DIAL_BREAKER_BASE_MS_DEFAULT;

export type RtcDialBreakerDecision = DialBreakerDecision;
export type RtcDialBreakerSnapshot = DialBreakerSnapshot;
export type RtcDialBreakerTripEvent = DialBreakerTripEvent;
export type RtcDialBreakerResetEvent = DialBreakerResetEvent;
export type RtcDialFailureResult = DialBreakerFailureResult;

export type RtcDialBreakerOptions = {
  now?: () => number;
  breakerMs?: number;
  failLimit?: number;
  healthyMs?: number;
  maxMs?: number;
  onTrip?: (event: RtcDialBreakerTripEvent) => void;
  onReset?: (event: RtcDialBreakerResetEvent) => void;
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

  constructor(opts: RtcDialBreakerOptions = {}) {
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
    return this.inner.shouldTry(peer, now);
  }

  snapshot(peer: string, now?: number): RtcDialBreakerSnapshot {
    return this.inner.snapshot(peer, now);
  }

  beginAttempt(peer: string, attemptId: string): void {
    this.inner.beginAttempt(peer, attemptId);
  }

  forceProbe(peer: string): void {
    this.inner.forceProbe(peer);
  }

  noteFailure(
    peer: string,
    kind = 'unknown',
    attemptId?: string,
    now?: number
  ): RtcDialFailureResult {
    return this.inner.noteFailure(peer, kind, attemptId, now);
  }

  noteChannelEstablished(peer: string, attemptId?: string, now?: number): void {
    this.inner.noteChannelEstablished(peer, attemptId, now);
  }

  noteHealthy(peer: string, now?: number): boolean {
    return this.inner.noteHealthy(peer, now);
  }

  notePeerChanged(peer: string): void {
    this.inner.notePeerChanged(peer);
  }

  reset(peer?: string): void {
    this.inner.reset(peer);
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
