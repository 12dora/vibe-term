export const SHARE_LOGIN_MAX_FAILURES = 10;
export const SHARE_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_KEYS = 10_000;

/** 按「分享 + 来源 IP」计失败次数：窗口内累计到上限即锁定，直至最早一次失败滑出窗口。 */
export class ShareLoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.failures.size;
  }

  private key(shareId: string, clientIp: string): string {
    return `${shareId}|${clientIp}`;
  }

  private live(key: string, now: number): number[] {
    const times = this.failures.get(key) ?? [];
    const cutoff = now - SHARE_LOGIN_WINDOW_MS;
    const kept = times.filter((at) => at > cutoff);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
    return kept;
  }

  /** 返回剩余锁定毫秒数；未锁定返回 0。 */
  lockedFor(shareId: string, clientIp: string): number {
    const now = this.now();
    const times = this.live(this.key(shareId, clientIp), now);
    if (times.length < SHARE_LOGIN_MAX_FAILURES) return 0;
    const oldest = times[0] ?? now;
    return Math.max(1, oldest + SHARE_LOGIN_WINDOW_MS - now);
  }

  recordFailure(shareId: string, clientIp: string): void {
    const now = this.now();
    const key = this.key(shareId, clientIp);
    const times = this.live(key, now);
    times.push(now);
    this.failures.set(key, times);
    if (this.failures.size > MAX_KEYS) this.sweep(now);
  }

  reset(shareId: string, clientIp: string): void {
    this.failures.delete(this.key(shareId, clientIp));
  }

  clear(): void {
    this.failures.clear();
  }

  sweep(now = this.now()): void {
    for (const key of [...this.failures.keys()]) this.live(key, now);
    while (this.failures.size > MAX_KEYS) {
      const victim = this.failures.keys().next().value;
      if (victim === undefined) break;
      this.failures.delete(victim);
    }
  }
}
