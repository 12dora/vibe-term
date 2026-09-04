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
    const failKey = failKeyOf(ip, uid);
    if (
      this.countIn(this.failures, failKey, t, HUB_ENROLL_FAIL_WINDOW_MS) >= HUB_ENROLL_FAIL_LIMIT
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
    this.recordInto(this.failures, failKeyOf(ip, uid), HUB_ENROLL_FAIL_WINDOW_MS);
  }

  recordSuccess(uid: string): void {
    if (!uid) return;
    this.recordInto(this.successes, successKeyOf(uid), HUB_ENROLL_SUCCESS_WINDOW_MS);
  }

  failureCount(ip: string, uid: string): number {
    return this.countIn(this.failures, failKeyOf(ip, uid), this.now(), HUB_ENROLL_FAIL_WINDOW_MS);
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
    while (this.failures.size + this.successes.size > this.maxKeys) {
      const oldest = this.failures.keys().next().value ?? this.successes.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
      this.successes.delete(oldest);
    }
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
}

function failKeyOf(ip: string, uid: string): string {
  return `fail:${ip}:${uid}`;
}

function successKeyOf(uid: string): string {
  return `ok:${uid}`;
}

function prune(times: number[], now: number, windowMs: number): number[] {
  return times.filter((t) => now - t < windowMs);
}
