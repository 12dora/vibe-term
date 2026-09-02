import {
  LOGIN_LIMITER_MAX_KEYS,
  LOGIN_LIMITER_PRUNE_EVERY,
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_WINDOW_MS,
} from './mesh-deps';

export class LoginFailureLimiter {
  private readonly failures = new Map<string, number[]>();
  private recordCount = 0;
  private readonly maxKeys: number;
  private readonly pruneEvery: number;

  constructor(
    private readonly now: () => number,
    options?: { maxKeys?: number; pruneEvery?: number }
  ) {
    this.maxKeys = options?.maxKeys ?? LOGIN_LIMITER_MAX_KEYS;
    this.pruneEvery = options?.pruneEvery ?? LOGIN_LIMITER_PRUNE_EVERY;
  }

  get size(): number {
    return this.failures.size;
  }

  isRateLimited(uid: string, ip: string): boolean {
    const t = this.now();
    const uidOver = uid ? this.countFailures(`uid:${uid}`, t) >= LOGIN_RATE_LIMIT : false;
    const ipOver = this.countFailures(`ip:${ip}`, t) >= LOGIN_RATE_LIMIT;
    return uidOver || ipOver;
  }

  count(key: string): number {
    return this.countFailures(key, this.now());
  }

  record(key: string): void {
    this.recordFailure(key);
  }

  recordFailure(key: string): void {
    this.recordCount += 1;
    if (this.pruneEvery > 0 && this.recordCount % this.pruneEvery === 0) {
      this.sweepAll();
    }
    const t = this.now();
    const next = this.prune(this.failures.get(key) ?? [], t);
    next.push(t);
    this.failures.set(key, next);
    while (this.failures.size > this.maxKeys) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }

  private countFailures(key: string, now: number): number {
    return this.storePruned(key, this.prune(this.failures.get(key) ?? [], now)).length;
  }

  private sweepAll(): void {
    const t = this.now();
    for (const [key, times] of this.failures) {
      this.storePruned(key, this.prune(times, t));
    }
  }

  private storePruned(key: string, next: number[]): number[] {
    if (next.length === 0) {
      this.failures.delete(key);
    } else {
      this.failures.set(key, next);
    }
    return next;
  }

  private prune(times: number[], now: number): number[] {
    return times.filter((t) => now - t < LOGIN_RATE_WINDOW_MS);
  }
}
