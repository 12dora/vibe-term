export const SHARE_LOGIN_MAX_FAILURES = 10;
export const SHARE_LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const SHARE_LOGIN_LOCK_MS = 15 * 60 * 1000;
/** 同一 (分享, IP) 上并发验证的上限：argon2 很贵，等待队列必须封顶。 */
export const SHARE_LOGIN_MAX_CONCURRENT = 2;
export const SHARE_LOGIN_BUSY_RETRY_MS = 1_000;
const MAX_KEYS = 10_000;

type LimiterEntry = {
  failures: number[];
  inflight: number;
  lockedUntil: number;
};

export type ShareLoginAttempt = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * 按「分享 + 来源 IP」限流。额度在密码验证**之前**预占：并发请求都算进次数，
 * 否则同时打进来的请求会全部通过检查，形成超额猜测。
 */
export class ShareLoginLimiter {
  private readonly entries = new Map<string, LimiterEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.entries.size;
  }

  private key(shareId: string, clientIp: string): string {
    return `${shareId}|${clientIp}`;
  }

  private live(key: string, now: number): LimiterEntry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const cutoff = now - SHARE_LOGIN_WINDOW_MS;
    entry.failures = entry.failures.filter((at) => at > cutoff);
    if (entry.failures.length === 0 && entry.inflight === 0 && entry.lockedUntil <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  /** 返回剩余锁定毫秒数；未锁定返回 0。 */
  lockedFor(shareId: string, clientIp: string): number {
    const now = this.now();
    const entry = this.live(this.key(shareId, clientIp), now);
    if (!entry) return 0;
    if (entry.lockedUntil > now) return entry.lockedUntil - now;
    return entry.failures.length + entry.inflight >= SHARE_LOGIN_MAX_FAILURES
      ? SHARE_LOGIN_BUSY_RETRY_MS
      : 0;
  }

  /** 预占一次尝试额度；返回 ok=false 时不得进入密码验证。成功必须配对调用 `settle`。 */
  begin(shareId: string, clientIp: string): ShareLoginAttempt {
    const now = this.now();
    const key = this.key(shareId, clientIp);
    const entry = this.live(key, now) ?? { failures: [], inflight: 0, lockedUntil: 0 };
    if (entry.lockedUntil > now) return { ok: false, retryAfterMs: entry.lockedUntil - now };
    if (entry.failures.length + entry.inflight >= SHARE_LOGIN_MAX_FAILURES) {
      return { ok: false, retryAfterMs: SHARE_LOGIN_BUSY_RETRY_MS };
    }
    if (entry.inflight >= SHARE_LOGIN_MAX_CONCURRENT) {
      return { ok: false, retryAfterMs: SHARE_LOGIN_BUSY_RETRY_MS };
    }
    entry.inflight += 1;
    this.entries.set(key, entry);
    if (this.entries.size > MAX_KEYS) this.sweep(now);
    return { ok: true };
  }

  /** 结算一次预占：成功即清空该 (分享, IP) 的失败记录，失败则落账。 */
  settle(shareId: string, clientIp: string, success: boolean): void {
    const key = this.key(shareId, clientIp);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.inflight = Math.max(0, entry.inflight - 1);
    if (success) {
      this.entries.delete(key);
      return;
    }
    const now = this.now();
    entry.failures.push(now);
    // 达到上限即锁满 15 分钟：只按最早一次失败滑出窗口算的话，
    // 「第 1 次失败 → 等 14:59 → 再失败 9 次」只会锁 1 毫秒。
    if (entry.failures.length >= SHARE_LOGIN_MAX_FAILURES) {
      entry.lockedUntil = Math.max(entry.lockedUntil, now + SHARE_LOGIN_LOCK_MS);
    }
    this.entries.set(key, entry);
  }

  recordFailure(shareId: string, clientIp: string): void {
    const key = this.key(shareId, clientIp);
    const entry = this.entries.get(key) ?? { failures: [], inflight: 0, lockedUntil: 0 };
    entry.inflight += 1;
    this.entries.set(key, entry);
    this.settle(shareId, clientIp, false);
    if (this.entries.size > MAX_KEYS) this.sweep(this.now());
  }

  reset(shareId: string, clientIp: string): void {
    this.entries.delete(this.key(shareId, clientIp));
  }

  clear(): void {
    this.entries.clear();
  }

  sweep(now = this.now()): void {
    for (const key of [...this.entries.keys()]) this.live(key, now);
    while (this.entries.size > MAX_KEYS) {
      const victim = this.entries.keys().next().value;
      if (victim === undefined) break;
      this.entries.delete(victim);
    }
  }
}
