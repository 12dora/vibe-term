import { SlidingWindowCounter } from '../lib/sliding-window';
import {
  LOGIN_LIMITER_MAX_KEYS,
  LOGIN_LIMITER_PRUNE_EVERY,
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_WINDOW_MS,
} from './mesh-deps';

export class LoginFailureLimiter {
  private readonly failures: SlidingWindowCounter;
  private recordCount = 0;
  private readonly pruneEvery: number;

  constructor(
    private readonly now: () => number,
    options?: { maxKeys?: number; pruneEvery?: number }
  ) {
    this.failures = new SlidingWindowCounter({
      windowMs: LOGIN_RATE_WINDOW_MS,
      now,
      maxKeys: options?.maxKeys ?? LOGIN_LIMITER_MAX_KEYS,
      evict: 'oldest',
    });
    this.pruneEvery = options?.pruneEvery ?? LOGIN_LIMITER_PRUNE_EVERY;
  }

  get size(): number {
    return this.failures.size;
  }

  isRateLimited(uid: string, ip: string): boolean {
    const t = this.now();
    const uidOver = uid ? this.failures.count(`uid:${uid}`, t) >= LOGIN_RATE_LIMIT : false;
    const ipOver = this.failures.count(`ip:${ip}`, t) >= LOGIN_RATE_LIMIT;
    return uidOver || ipOver;
  }

  count(key: string): number {
    return this.failures.count(key, this.now());
  }

  record(key: string): void {
    this.recordFailure(key);
  }

  recordFailure(key: string): void {
    this.recordCount += 1;
    if (this.pruneEvery > 0 && this.recordCount % this.pruneEvery === 0) {
      this.failures.sweep(this.now());
    }
    this.failures.hit(key, this.now());
  }
}
