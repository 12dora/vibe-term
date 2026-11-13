import { limiterIpKey } from '../mesh/client-ip';

export const SHARE_LOGIN_MAX_FAILURES = 10;
export const SHARE_LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const SHARE_LOGIN_LOCK_MS = 15 * 60 * 1000;
/** 同一 (分享, IP) 上并发验证的上限：argon2 很贵，等待队列必须封顶。 */
export const SHARE_LOGIN_MAX_CONCURRENT = 2;
export const SHARE_LOGIN_BUSY_RETRY_MS = 1_000;
/**
 * 同一分享不分来源的失败上限：窗口内到顶后进入降速——整个分享每 30 秒最多一次校验，
 * 轮换来源 IP 也快不起来，但持正确口令的访客最多等一个间隔，不会被整段锁死。
 */
export const SHARE_LOGIN_SHARE_MAX_FAILURES = 50;
export const SHARE_LOGIN_SHARE_WINDOW_MS = 60 * 60 * 1000;
export const SHARE_LOGIN_SHARE_SLOWDOWN_MS = 30_000;
/** 整个进程同时在跑的分享口令 argon2 校验上限；超出立即 429，不排队。 */
export const SHARE_VERIFY_MAX_INFLIGHT = 4;
const MAX_KEYS = 10_000;

type LimiterEntry = {
  failures: number[];
  inflight: number;
  lockedUntil: number;
  lastAttemptAt: number;
};

/** `busy`：并发上限（换个时刻重试即可）；`locked`：失败次数触发的锁定或降速。 */
export type ShareLoginAttempt =
  | { ok: true }
  | { ok: false; reason: 'locked' | 'busy'; retryAfterMs: number };

function emptyEntry(): LimiterEntry {
  return { failures: [], inflight: 0, lockedUntil: 0, lastAttemptAt: 0 };
}

/**
 * 三层限流：「分享 + 来源 IP」（IPv6 按 /64）、「分享」全局失败桶、进程级校验并发。
 * 额度在密码验证**之前**预占：并发请求都算进次数，否则同时打进来的请求会全部通过检查，
 * 形成超额猜测。每个进程只有一个做口令校验的实例（`ShareAccessManager`），并发上限即进程级。
 */
export class ShareLoginLimiter {
  private readonly entries = new Map<string, LimiterEntry>();
  private readonly shares = new Map<string, LimiterEntry>();
  private verifying = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.entries.size;
  }

  private key(shareId: string, clientIp: string): string {
    return `${shareId}|${limiterIpKey(clientIp)}`;
  }

  private live(
    map: Map<string, LimiterEntry>,
    key: string,
    windowMs: number,
    now: number
  ): LimiterEntry | null {
    const entry = map.get(key);
    if (!entry) return null;
    const cutoff = now - windowMs;
    entry.failures = entry.failures.filter((at) => at > cutoff);
    if (entry.failures.length === 0 && entry.inflight === 0 && entry.lockedUntil <= now) {
      map.delete(key);
      return null;
    }
    return entry;
  }

  private liveEntry(key: string, now: number): LimiterEntry | null {
    return this.live(this.entries, key, SHARE_LOGIN_WINDOW_MS, now);
  }

  private liveShare(shareId: string, now: number): LimiterEntry | null {
    return this.live(this.shares, shareId, SHARE_LOGIN_SHARE_WINDOW_MS, now);
  }

  /** 返回剩余锁定毫秒数；未锁定返回 0。 */
  lockedFor(shareId: string, clientIp: string): number {
    const now = this.now();
    return Math.max(
      blockedFor(this.liveEntry(this.key(shareId, clientIp), now), now),
      shareThrottledFor(this.liveShare(shareId, now), now)
    );
  }

  /** 预占一次尝试额度；返回 ok=false 时不得进入密码验证。成功必须配对调用 `settle`。 */
  begin(shareId: string, clientIp: string): ShareLoginAttempt {
    const now = this.now();
    const key = this.key(shareId, clientIp);
    const entry = this.liveEntry(key, now) ?? emptyEntry();
    const share = this.liveShare(shareId, now) ?? emptyEntry();
    const blocked = Math.max(blockedFor(entry, now), shareThrottledFor(share, now));
    if (blocked > 0) return { ok: false, reason: 'locked', retryAfterMs: blocked };
    if (
      entry.inflight >= SHARE_LOGIN_MAX_CONCURRENT ||
      this.verifying >= SHARE_VERIFY_MAX_INFLIGHT
    ) {
      return { ok: false, reason: 'busy', retryAfterMs: SHARE_LOGIN_BUSY_RETRY_MS };
    }
    entry.inflight += 1;
    share.inflight += 1;
    share.lastAttemptAt = now;
    this.verifying += 1;
    this.entries.set(key, entry);
    this.shares.set(shareId, share);
    if (this.entries.size > MAX_KEYS || this.shares.size > MAX_KEYS) this.sweep(now);
    return { ok: true };
  }

  /** 结算一次预占：成功即清空该 (分享, IP) 的失败记录，失败则落账；分享全局桶只增不清，只降速不锁死。 */
  settle(shareId: string, clientIp: string, success: boolean): void {
    this.verifying = Math.max(0, this.verifying - 1);
    const share = this.shares.get(shareId);
    if (share) share.inflight = Math.max(0, share.inflight - 1);
    const key = this.key(shareId, clientIp);
    const entry = this.entries.get(key);
    if (entry) entry.inflight = Math.max(0, entry.inflight - 1);
    if (success) {
      this.entries.delete(key);
      return;
    }
    this.book(shareId, key);
  }

  recordFailure(shareId: string, clientIp: string): void {
    this.book(shareId, this.key(shareId, clientIp));
    if (this.entries.size > MAX_KEYS || this.shares.size > MAX_KEYS) this.sweep(this.now());
  }

  private book(shareId: string, key: string): void {
    const now = this.now();
    const entry = this.entries.get(key) ?? emptyEntry();
    entry.failures.push(now);
    // 达到上限即锁满 15 分钟：只按最早一次失败滑出窗口算的话，
    // 「第 1 次失败 → 等 14:59 → 再失败 9 次」只会锁 1 毫秒。
    if (entry.failures.length >= SHARE_LOGIN_MAX_FAILURES) {
      entry.lockedUntil = Math.max(entry.lockedUntil, now + SHARE_LOGIN_LOCK_MS);
    }
    this.entries.set(key, entry);
    const share = this.shares.get(shareId) ?? emptyEntry();
    share.failures.push(now);
    this.shares.set(shareId, share);
  }

  reset(shareId: string, clientIp: string): void {
    this.entries.delete(this.key(shareId, clientIp));
  }

  clear(): void {
    this.entries.clear();
    this.shares.clear();
  }

  sweep(now = this.now()): void {
    for (const key of [...this.entries.keys()]) this.liveEntry(key, now);
    for (const shareId of [...this.shares.keys()]) this.liveShare(shareId, now);
    for (const map of [this.entries, this.shares]) {
      while (map.size > MAX_KEYS) {
        const victim = map.keys().next().value;
        if (victim === undefined) break;
        map.delete(victim);
      }
    }
  }
}

function blockedFor(entry: LimiterEntry | null, now: number): number {
  if (!entry) return 0;
  if (entry.lockedUntil > now) return entry.lockedUntil - now;
  return entry.failures.length + entry.inflight >= SHARE_LOGIN_MAX_FAILURES
    ? SHARE_LOGIN_BUSY_RETRY_MS
    : 0;
}

/** 分享级降速：失败（含在途）到顶后，同一时刻只允许一次校验，且两次校验至少间隔一个降速周期。 */
function shareThrottledFor(share: LimiterEntry | null, now: number): number {
  if (!share || share.failures.length + share.inflight < SHARE_LOGIN_SHARE_MAX_FAILURES) return 0;
  if (share.inflight > 0) return SHARE_LOGIN_SHARE_SLOWDOWN_MS;
  return Math.max(0, share.lastAttemptAt + SHARE_LOGIN_SHARE_SLOWDOWN_MS - now);
}
