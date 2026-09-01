import { LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS } from './mesh-deps';

export class LoginFailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly now: () => number) {}

  isRateLimited(uid: string, ip: string): boolean {
    const t = this.now();
    const uidOver = uid ? this.countFailures(`uid:${uid}`, t) >= LOGIN_RATE_LIMIT : false;
    const ipOver = this.countFailures(`ip:${ip}`, t) >= LOGIN_RATE_LIMIT;
    return uidOver || ipOver;
  }

  recordFailure(key: string): void {
    const t = this.now();
    const next = this.prune(this.failures.get(key) ?? [], t);
    next.push(t);
    this.failures.set(key, next);
  }

  private countFailures(key: string, now: number): number {
    const next = this.prune(this.failures.get(key) ?? [], now);
    this.failures.set(key, next);
    return next.length;
  }

  private prune(times: number[], now: number): number[] {
    return times.filter((t) => now - t < LOGIN_RATE_WINDOW_MS);
  }
}
