import { SlidingWindowCounter } from '../lib/sliding-window';

export const HUB_ENROLL_FAIL_LIMIT = 10;
export const HUB_ENROLL_FAIL_WINDOW_MS = 60_000;
export const HUB_ENROLL_SUCCESS_LIMIT = 5;
export const HUB_ENROLL_SUCCESS_WINDOW_MS = 60 * 60 * 1000;
export const HUB_ENROLL_LIMITER_MAX_KEYS = 10_000;
export const HUB_ENROLL_LIMITER_PRUNE_EVERY = 256;

export class HubEnrollLimiter {
  private readonly failures: SlidingWindowCounter;
  private readonly successes: SlidingWindowCounter;
  private recordCount = 0;
  private readonly maxKeys: number;
  private readonly pruneEvery: number;

  constructor(
    private readonly now: () => number,
    options?: { maxKeys?: number; pruneEvery?: number }
  ) {
    this.maxKeys = options?.maxKeys ?? HUB_ENROLL_LIMITER_MAX_KEYS;
    this.pruneEvery = options?.pruneEvery ?? HUB_ENROLL_LIMITER_PRUNE_EVERY;
    // 失败桶与成功桶共用一份 maxKeys 预算，且只回收已过期的桶：仍在窗口内的桶永不被挤掉。
    this.failures = new SlidingWindowCounter({
      windowMs: HUB_ENROLL_FAIL_WINDOW_MS,
      now,
      evict: 'expired-only',
    });
    this.successes = new SlidingWindowCounter({
      windowMs: HUB_ENROLL_SUCCESS_WINDOW_MS,
      now,
      evict: 'expired-only',
    });
  }

  isLimited(ip: string, uid: string): boolean {
    const t = this.now();
    if (this.failures.count(failIpKey(ip), t) >= HUB_ENROLL_FAIL_LIMIT) return true;
    if (uid && this.failures.count(failUidKey(uid), t) >= HUB_ENROLL_FAIL_LIMIT) return true;
    if (!uid) return false;
    return this.successes.count(successKeyOf(uid), t) >= HUB_ENROLL_SUCCESS_LIMIT;
  }

  recordFailure(ip: string, uid: string): void {
    if (ip) this.recordInto(this.failures, failIpKey(ip));
    if (uid) this.recordInto(this.failures, failUidKey(uid));
  }

  /** 成功上限的同步占位：persist 之前调用，失败再 `releaseSuccess`。 */
  tryReserveSuccess(uid: string): boolean {
    if (!uid) return true;
    const t = this.now();
    if (this.failures.count(failUidKey(uid), t) >= HUB_ENROLL_FAIL_LIMIT) return false;
    if (this.successes.count(successKeyOf(uid), t) >= HUB_ENROLL_SUCCESS_LIMIT) return false;
    this.recordInto(this.successes, successKeyOf(uid));
    return true;
  }

  releaseSuccess(uid: string): void {
    if (!uid) return;
    this.successes.release(successKeyOf(uid));
  }

  recordSuccess(uid: string): void {
    this.tryReserveSuccess(uid);
  }

  failureCount(ip: string, uid: string): number {
    const key = uid ? failUidKey(uid) : failIpKey(ip);
    return this.failures.count(key, this.now());
  }

  successCount(uid: string): number {
    return this.successes.count(successKeyOf(uid), this.now());
  }

  get size(): number {
    return this.failures.size + this.successes.size;
  }

  private recordInto(store: SlidingWindowCounter, key: string): void {
    this.recordCount += 1;
    if (this.pruneEvery > 0 && this.recordCount % this.pruneEvery === 0) this.sweepAll();
    store.hit(key, this.now());
    if (this.size > this.maxKeys) this.sweepAll();
  }

  private sweepAll(): void {
    const t = this.now();
    this.failures.sweep(t);
    this.successes.sweep(t);
  }
}

function failIpKey(ip: string): string {
  return `fail:ip:${ip}`;
}

function failUidKey(uid: string): string {
  return `fail:uid:${uid}`;
}

function successKeyOf(uid: string): string {
  return `ok:${uid}`;
}
