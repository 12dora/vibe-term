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
