import {
  type KeywordRule,
  classifyByKeywords,
  truncateReason,
} from '../../../../packages/shared/src/net/classify-by-keywords';
import {
  DIAL_BREAKER_BASE_MS,
  DIAL_BREAKER_FAILS,
  DIAL_BREAKER_HEALTHY_MS,
  DIAL_BREAKER_MAX_MS,
  DialBreaker,
  type DialBreakerDecision,
  type DialBreakerSnapshot,
} from '../../../../packages/shared/src/net/dial-breaker';

export const DIRECT_DIAL_BREAKER_FAILS = DIAL_BREAKER_FAILS;
export const DIRECT_DIAL_BREAKER_BASE_MS = DIAL_BREAKER_BASE_MS;
export const DIRECT_DIAL_BREAKER_MAX_MS = DIAL_BREAKER_MAX_MS;
export const DIRECT_DIAL_BREAKER_HEALTHY_MS = DIAL_BREAKER_HEALTHY_MS;

export type DirectDialBreakerDecision = DialBreakerDecision;
export type DirectDialBreakerSnapshot = DialBreakerSnapshot;

export type DirectDialBreakerOptions = {
  now?: () => number;
  breakerMs?: number;
  failLimit?: number;
  healthyMs?: number;
  maxMs?: number;
};

const SKIP_KINDS = new Set(['signaling-not-ready', 'primary-wait', '']);

const DIRECT_DIAL_FAILURE_RULES: ReadonlyArray<KeywordRule<string | null>> = [
  [['signaling not ready'], null],
  [['no_connection', 'multiple_connections'], null],
  [['authoriz'], 'authorization'],
  [['fingerprint'], 'fingerprint'],
  [['timeout', 'timed out'], 'timeout'],
  [['ice'], 'ice'],
  [['protocol'], 'protocol'],
  [['carrier', 'switched back'], 'carrier'],
  [['channel', 'datachannel'], 'channel'],
];

export function classifyDirectDialFailure(reason: string | null | undefined): string | null {
  if (!reason) return 'unknown';
  return classifyByKeywords<string | null>(reason, DIRECT_DIAL_FAILURE_RULES, () =>
    truncateReason(reason)
  );
}

export class DirectDialBreaker {
  private readonly inner: DialBreaker;
  private readonly now: () => number;

  constructor(opts: DirectDialBreakerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.inner = new DialBreaker({
      now: this.now,
      breakerMs: opts.breakerMs ?? DIRECT_DIAL_BREAKER_BASE_MS,
      failLimit: opts.failLimit ?? DIRECT_DIAL_BREAKER_FAILS,
      healthyMs: opts.healthyMs ?? DIRECT_DIAL_BREAKER_HEALTHY_MS,
      maxMs: opts.maxMs ?? DIRECT_DIAL_BREAKER_MAX_MS,
      skipKinds: SKIP_KINDS,
      trackAttempts: false,
    });
  }

  shouldTry(peer: string, now?: number): DirectDialBreakerDecision {
    return this.inner.shouldTry(peer, now);
  }

  snapshot(peer: string, now?: number): DirectDialBreakerSnapshot {
    return this.inner.snapshot(peer, now);
  }

  beginAttempt(peer: string, attemptId: string): void {
    this.inner.beginAttempt(peer, attemptId);
  }

  forceProbe(peer: string): void {
    this.inner.forceProbe(peer);
  }

  noteFailure(peer: string, kind: string, attemptId?: string, now?: number): boolean {
    return this.inner.noteFailure(peer, kind, attemptId, now).counted;
  }

  noteChannelEstablished(peer: string, attemptId?: string, now?: number): void {
    this.inner.noteChannelEstablished(peer, attemptId, now);
  }

  noteHealthy(peer: string, now?: number): boolean {
    return this.inner.noteHealthy(peer, now);
  }

  remainingCooldownMs(peer: string, now = this.now()): number {
    return this.inner.remainingCooldownMs(peer, now);
  }

  reset(peer?: string): void {
    this.inner.reset(peer);
  }
}
