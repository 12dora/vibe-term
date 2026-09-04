export const HUB_ENROLL_FAIL_LIMIT = 10;
export const HUB_ENROLL_FAIL_WINDOW_MS = 60_000;
export const HUB_ENROLL_SUCCESS_LIMIT = 5;
export const HUB_ENROLL_SUCCESS_WINDOW_MS = 60 * 60 * 1000;
export const HUB_ENROLL_LIMITER_MAX_KEYS = 10_000;
export const HUB_ENROLL_LIMITER_PRUNE_EVERY = 256;

type WindowedHits = Map<string, number[]>;

export class HubEnrollLimiter {
  private readonly failures: WindowedHits = new Map();
  private readonly successes: WindowedHits = new Map();
  private recordCount = 0;
  private readonly maxKeys: number;
  private readonly pruneEvery: number;

  constructor(
    private readonly now: () => number,
    options?: { maxKeys?: number; pruneEvery?: number }
  ) {
    this.maxKeys = options?.maxKeys ?? HUB_ENROLL_LIMITER_MAX_KEYS;
    this.pruneEvery = options?.pruneEvery ?? HUB_ENROLL_LIMITER_PRUNE_EVERY;
  }

  isLimited(ip: string, uid: string): boolean {
    const t = this.now();
    if (
      this.countIn(this.failures, failIpKey(ip), t, HUB_ENROLL_FAIL_WINDOW_MS) >=
      HUB_ENROLL_FAIL_LIMIT
    ) {
      return true;
    }
    if (
      uid &&
      this.countIn(this.failures, failUidKey(uid), t, HUB_ENROLL_FAIL_WINDOW_MS) >=
        HUB_ENROLL_FAIL_LIMIT
    ) {
      return true;
    }
    if (!uid) return false;
    return (
      this.countIn(this.successes, successKeyOf(uid), t, HUB_ENROLL_SUCCESS_WINDOW_MS) >=
      HUB_ENROLL_SUCCESS_LIMIT
    );
  }

  recordFailure(ip: string, uid: string): void {
    if (ip) this.recordInto(this.failures, failIpKey(ip), HUB_ENROLL_FAIL_WINDOW_MS);
    if (uid) this.recordInto(this.failures, failUidKey(uid), HUB_ENROLL_FAIL_WINDOW_MS);
  }

  /** 成功上限的同步占位：persist 之前调用，失败再 `releaseSuccess`。 */
  tryReserveSuccess(uid: string): boolean {
    if (!uid) return true;
    const t = this.now();
    if (
      this.countIn(this.failures, failUidKey(uid), t, HUB_ENROLL_FAIL_WINDOW_MS) >=
      HUB_ENROLL_FAIL_LIMIT
    ) {
      return false;
    }
    if (
      this.countIn(this.successes, successKeyOf(uid), t, HUB_ENROLL_SUCCESS_WINDOW_MS) >=
      HUB_ENROLL_SUCCESS_LIMIT
    ) {
      return false;
    }
    this.recordInto(this.successes, successKeyOf(uid), HUB_ENROLL_SUCCESS_WINDOW_MS);
    return true;
  }

  releaseSuccess(uid: string): void {
    if (!uid) return;
    const key = successKeyOf(uid);
    const times = this.successes.get(key);
    if (!times || times.length === 0) return;
    times.pop();
    if (times.length === 0) this.successes.delete(key);
    else this.successes.set(key, times);
  }

  recordSuccess(uid: string): void {
    this.tryReserveSuccess(uid);
  }

  failureCount(ip: string, uid: string): number {
    if (uid) {
      return this.countIn(this.failures, failUidKey(uid), this.now(), HUB_ENROLL_FAIL_WINDOW_MS);
    }
    return this.countIn(this.failures, failIpKey(ip), this.now(), HUB_ENROLL_FAIL_WINDOW_MS);
  }

  successCount(uid: string): number {
    return this.countIn(
      this.successes,
      successKeyOf(uid),
      this.now(),
      HUB_ENROLL_SUCCESS_WINDOW_MS
    );
  }

  get size(): number {
    return this.failures.size + this.successes.size;
  }

  private recordInto(store: WindowedHits, key: string, windowMs: number): void {
    this.recordCount += 1;
    if (this.pruneEvery > 0 && this.recordCount % this.pruneEvery === 0) {
      this.sweep(this.failures, HUB_ENROLL_FAIL_WINDOW_MS);
      this.sweep(this.successes, HUB_ENROLL_SUCCESS_WINDOW_MS);
    }
    const t = this.now();
    const next = prune(store.get(key) ?? [], t, windowMs);
    next.push(t);
    store.set(key, next);
    this.evictExpiredOnly();
  }

  private countIn(store: WindowedHits, key: string, now: number, windowMs: number): number {
    const next = prune(store.get(key) ?? [], now, windowMs);
    if (next.length === 0) store.delete(key);
    else store.set(key, next);
    return next.length;
  }

  private sweep(store: WindowedHits, windowMs: number): void {
    const t = this.now();
    for (const [key, times] of store) {
      const next = prune(times, t, windowMs);
      if (next.length === 0) store.delete(key);
      else store.set(key, next);
    }
  }

  /** 只删窗口已过期的桶；仍在窗口内或已触达上限的桶永不驱逐。 */
  private evictExpiredOnly(): void {
    if (this.failures.size + this.successes.size <= this.maxKeys) return;
    this.sweep(this.failures, HUB_ENROLL_FAIL_WINDOW_MS);
    this.sweep(this.successes, HUB_ENROLL_SUCCESS_WINDOW_MS);
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

function prune(times: number[], now: number, windowMs: number): number[] {
  return times.filter((t) => now - t < windowMs);
}
