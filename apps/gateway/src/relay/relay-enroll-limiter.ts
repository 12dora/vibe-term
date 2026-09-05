import { SlidingWindowCounter } from '../lib/sliding-window';
import {
  RELAY_ENROLL_CREATE_LIMIT,
  RELAY_ENROLL_CREATE_WINDOW_MS,
  RELAY_ENROLL_FAILURE_LIMIT,
  RELAY_ENROLL_FAILURE_WINDOW_MS,
} from './types';

export const RELAY_ENROLL_LIMITER_MAX_KEYS = 4096;

/** 按源 IP（及可选租户编号）记 enroll / kdf 失败次数，窗口内累计到上限即拒。 */
export class RelayEnrollLimiter {
  private readonly failures: SlidingWindowCounter;

  constructor(
    now: () => number = Date.now,
    private readonly limit = RELAY_ENROLL_FAILURE_LIMIT,
    windowMs = RELAY_ENROLL_FAILURE_WINDOW_MS,
    maxKeys = RELAY_ENROLL_LIMITER_MAX_KEYS
  ) {
    // 只回收窗口已过期的桶：仍在窗口内的失败计数不会被高基数的源 IP 挤掉。
    this.failures = new SlidingWindowCounter({ windowMs, now, maxKeys, evict: 'expired-only' });
  }

  get size(): number {
    return this.failures.size;
  }

  isLimited(ip: string, tenantId?: string): boolean {
    if (ip && this.count(ip) >= this.limit) return true;
    if (tenantId && this.count(tenantKey(tenantId)) >= this.limit) return true;
    return false;
  }

  count(ip: string): number {
    return this.failures.count(ip);
  }

  recordFailure(ip: string, tenantId?: string): void {
    if (ip) this.failures.hit(ip);
    if (tenantId) this.failures.hit(tenantKey(tenantId));
  }

  reset(ip: string, tenantId?: string): void {
    this.failures.reset(ip);
    if (tenantId) this.failures.reset(tenantKey(tenantId));
  }

  clear(): void {
    this.failures.clear();
  }
}

/** 每租户 `relay.enroll.create` 频率闸：滑动窗口计数，`sweep` 回收空桶。 */
export class RelayEnrollCreateRate {
  private readonly marks: SlidingWindowCounter;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limit = RELAY_ENROLL_CREATE_LIMIT,
    windowMs = RELAY_ENROLL_CREATE_WINDOW_MS
  ) {
    this.marks = new SlidingWindowCounter({ windowMs, now });
  }

  allow(tenantId: string): boolean {
    const now = this.now();
    if (this.marks.count(tenantId, now) >= this.limit) return false;
    this.marks.hit(tenantId, now);
    return true;
  }

  sweep(): void {
    this.marks.sweep(this.now());
  }

  clear(): void {
    this.marks.clear();
  }
}

function tenantKey(tenantId: string): string {
  return `tenant:${tenantId}`;
}
