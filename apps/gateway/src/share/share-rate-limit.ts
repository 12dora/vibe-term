import { UNKNOWN_CLIENT_KEY, limiterIpKey } from '../mesh/client-ip';

/** 同一 (分享, IP) 前几次失败不退避。 */
export const SHARE_LOGIN_GRACE_FAILURES = 3;
/** 宽限期过后第一次退避：2 s、4 s、8 s … */
export const SHARE_LOGIN_BACKOFF_START_MS = 2_000;
export const SHARE_LOGIN_BACKOFF_CAP_MS = 15 * 60 * 1000;
/** 同一 (分享, IP) 上并发验证的上限：argon2 很贵，等待队列必须封顶。 */
export const SHARE_LOGIN_MAX_CONCURRENT = 2;
export const SHARE_LOGIN_BUSY_RETRY_MS = 1_000;
/**
 * 同一分享不分来源的失败上限：窗口内到顶后，脏来源每 30 秒最多一次校验；
 * 零失败或近 24 h 成功过的干净 IP 不受牵连。
 */
export const SHARE_LOGIN_SHARE_MAX_FAILURES = 50;
export const SHARE_LOGIN_SHARE_WINDOW_MS = 60 * 60 * 1000;
export const SHARE_LOGIN_SHARE_SLOWDOWN_MS = 30_000;
export const SHARE_LOGIN_SUCCESS_MEMORY_MS = 24 * 60 * 60 * 1000;
/** 整个进程同时在跑的分享口令 argon2 校验上限；超出立即 429，不排队。 */
export const SHARE_VERIFY_MAX_INFLIGHT = 4;
export const SHARE_LOGIN_MAX_KEYS = 10_000;

export type ShareLoginAttempt =
  | { ok: true }
  | { ok: false; reason: 'locked' | 'busy'; retryAfterMs: number };

type IpBucket = {
  failureCount: number;
  lastFailureAt: number;
  lastSuccessAt: number;
  inflight: number;
};

type ShareBucket = {
  failures: number[];
  lastAttemptAt: number;
};

function emptyIp(): IpBucket {
  return { failureCount: 0, lastFailureAt: -1, lastSuccessAt: -1, inflight: 0 };
}

function emptyShare(): ShareBucket {
  return { failures: [], lastAttemptAt: 0 };
}

export function shareLoginBackoffMs(failures: number): number {
  if (failures < SHARE_LOGIN_GRACE_FAILURES) return 0;
  const steps = Math.min(failures - SHARE_LOGIN_GRACE_FAILURES, 20);
  return Math.min(SHARE_LOGIN_BACKOFF_CAP_MS, SHARE_LOGIN_BACKOFF_START_MS * 2 ** steps);
}

function ipBackoffRemaining(entry: IpBucket | null, now: number): number {
  if (!entry) return 0;
  const wait = shareLoginBackoffMs(entry.failureCount);
  if (wait <= 0 || entry.lastFailureAt < 0) return 0;
  return Math.max(0, entry.lastFailureAt + wait - now);
}

function isUnknownClient(clientIp: string): boolean {
  return limiterIpKey(clientIp) === UNKNOWN_CLIENT_KEY;
}

function isCleanIp(clientIp: string, entry: IpBucket | null, now: number): boolean {
  if (isUnknownClient(clientIp)) return false;
  const successAt = entry?.lastSuccessAt ?? -1;
  if (successAt >= 0 && now - successAt < SHARE_LOGIN_SUCCESS_MEMORY_MS) return true;
  return !entry || entry.failureCount === 0;
}

function shareSlowdownRemaining(
  clientIp: string,
  entry: IpBucket | null,
  share: ShareBucket | null,
  now: number
): number {
  if (!share || share.failures.length < SHARE_LOGIN_SHARE_MAX_FAILURES) return 0;
  if (isCleanIp(clientIp, entry, now)) return 0;
  return Math.max(0, share.lastAttemptAt + SHARE_LOGIN_SHARE_SLOWDOWN_MS - now);
}

function ipIdle(entry: IpBucket, now: number): boolean {
  if (entry.inflight > 0 || entry.failureCount > 0) return false;
  if (entry.lastSuccessAt < 0) return true;
  return now - entry.lastSuccessAt >= SHARE_LOGIN_SUCCESS_MEMORY_MS;
}

function touch<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
}

function evictLru<T extends { inflight?: number }>(map: Map<string, T>, maxKeys: number): void {
  if (map.size <= maxKeys) return;
  for (const [key, row] of map) {
    if (map.size <= maxKeys) return;
    if ((row.inflight ?? 0) > 0) continue;
    map.delete(key);
  }
  while (map.size > maxKeys) {
    const victim = map.keys().next().value;
    if (victim === undefined) break;
    map.delete(victim);
  }
}

/**
 * 两层限流：「分享 + 来源 IP」（IPv6 按 /64）指数退避、「分享」滑动窗口反轮换。
 * 额度在密码验证**之前**预占。入口与节点各有一份进程内计数器，阈值按完整宽限计算、并不对半。
 */
export class ShareLoginLimiter {
  private readonly entries = new Map<string, IpBucket>();
  private readonly shares = new Map<string, ShareBucket>();
  private verifying = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys: number = SHARE_LOGIN_MAX_KEYS
  ) {}

  get size(): number {
    return this.entries.size;
  }

  private key(shareId: string, clientIp: string): string {
    return `${shareId}|${limiterIpKey(clientIp)}`;
  }

  private liveIp(key: string, now: number): IpBucket | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (ipIdle(entry, now)) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  private liveShare(shareId: string, now: number): ShareBucket | null {
    const share = this.shares.get(shareId);
    if (!share) return null;
    const cutoff = now - SHARE_LOGIN_SHARE_WINDOW_MS;
    share.failures = share.failures.filter((at) => at > cutoff);
    if (share.failures.length === 0) {
      this.shares.delete(shareId);
      return null;
    }
    return share;
  }

  private delayMs(
    clientIp: string,
    entry: IpBucket | null,
    share: ShareBucket | null,
    now: number
  ): number {
    const shareWait = shareSlowdownRemaining(clientIp, entry, share, now);
    return Math.max(ipBackoffRemaining(entry, now), shareWait);
  }

  /** 返回剩余等待毫秒数；未受限返回 0。 */
  lockedFor(shareId: string, clientIp: string): number {
    const now = this.now();
    const key = this.key(shareId, clientIp);
    const entry = this.liveIp(key, now);
    if (entry) touch(this.entries, key, entry);
    return this.delayMs(clientIp, entry, this.liveShare(shareId, now), now);
  }

  /** 预占一次尝试额度；返回 ok=false 时不得进入密码验证。成功必须配对调用 `settle`。 */
  begin(shareId: string, clientIp: string): ShareLoginAttempt {
    const now = this.now();
    const key = this.key(shareId, clientIp);
    const entry = this.liveIp(key, now) ?? emptyIp();
    const share = this.liveShare(shareId, now) ?? emptyShare();
    const blocked = this.delayMs(clientIp, entry, share, now);
    if (blocked > 0) return { ok: false, reason: 'locked', retryAfterMs: blocked };
    const concurrent = entry.inflight >= SHARE_LOGIN_MAX_CONCURRENT;
    const saturated = this.verifying >= SHARE_VERIFY_MAX_INFLIGHT;
    if (concurrent || saturated) {
      return { ok: false, reason: 'busy', retryAfterMs: SHARE_LOGIN_BUSY_RETRY_MS };
    }
    this.reserve(shareId, clientIp, entry, share, now);
    return { ok: true };
  }

  private reserve(
    shareId: string,
    clientIp: string,
    entry: IpBucket,
    share: ShareBucket,
    now: number
  ): void {
    entry.inflight += 1;
    this.verifying += 1;
    touch(this.entries, this.key(shareId, clientIp), entry);
    const throttled = share.failures.length >= SHARE_LOGIN_SHARE_MAX_FAILURES;
    if (throttled && !isCleanIp(clientIp, entry, now)) {
      share.lastAttemptAt = now;
      touch(this.shares, shareId, share);
    }
    this.cap(now);
  }

  /** 结算一次预占：成功清空该 (分享, IP) 失败并记 24 h 成功；失败落账。分享全局桶只增不因成功而清。 */
  settle(shareId: string, clientIp: string, success: boolean): void {
    this.verifying = Math.max(0, this.verifying - 1);
    const key = this.key(shareId, clientIp);
    const entry = this.entries.get(key);
    if (entry) entry.inflight = Math.max(0, entry.inflight - 1);
    if (success) this.rememberSuccess(key);
    else this.book(shareId, key);
  }

  recordFailure(shareId: string, clientIp: string): void {
    this.book(shareId, this.key(shareId, clientIp));
  }

  /** 入口转发 2xx：清该 IP 失败并记 24 h 成功，不影响其它 IP 与分享失败窗。 */
  reset(shareId: string, clientIp: string): void {
    this.rememberSuccess(this.key(shareId, clientIp));
  }

  private rememberSuccess(key: string): void {
    const now = this.now();
    const entry = this.entries.get(key) ?? emptyIp();
    entry.failureCount = 0;
    entry.lastFailureAt = -1;
    entry.lastSuccessAt = now;
    touch(this.entries, key, entry);
    this.cap(now);
  }

  private book(shareId: string, key: string): void {
    const now = this.now();
    const entry = this.entries.get(key) ?? emptyIp();
    entry.failureCount += 1;
    entry.lastFailureAt = now;
    touch(this.entries, key, entry);
    const share = this.liveShare(shareId, now) ?? emptyShare();
    share.failures.push(now);
    share.lastAttemptAt = now;
    touch(this.shares, shareId, share);
    this.cap(now);
  }

  clear(): void {
    this.entries.clear();
    this.shares.clear();
    this.verifying = 0;
  }

  sweep(now = this.now()): void {
    for (const key of [...this.entries.keys()]) this.liveIp(key, now);
    for (const shareId of [...this.shares.keys()]) this.liveShare(shareId, now);
    this.cap(now);
  }

  private cap(now: number): void {
    if (this.entries.size <= this.maxKeys && this.shares.size <= this.maxKeys) return;
    for (const key of [...this.entries.keys()]) this.liveIp(key, now);
    for (const shareId of [...this.shares.keys()]) this.liveShare(shareId, now);
    evictLru(this.entries, this.maxKeys);
    evictLru(this.shares, this.maxKeys);
  }
}
