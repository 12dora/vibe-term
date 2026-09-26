import type { LoginPolicy } from '@vibeterm/shared/auth';
import { SlidingWindowCounter } from '../lib/sliding-window';
import { LockQueue, type LockTicket } from './auth-login-lock-queue';
import {
  LOGIN_LIMITER_MAX_KEYS,
  LOGIN_LIMITER_PRUNE_EVERY,
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_WINDOW_MS,
} from './mesh-deps';

/** 挑战 / passkey options 仍用固定 60s 滑动窗口。登录失败改走 `LoginPolicyLimiter`。 */
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

export type LoginMethod = 'root' | 'passkey' | null;

export type LoginLimitAttempt = {
  ip: string;
  uid: string;
  method: LoginMethod;
  /** 回环/局域网且无代理头：IP 阶梯和账号暂停都不计、也不拦截。 */
  exempt: boolean;
  /** 缺省计入账号。入口转发登录只计 IP，由目标节点计 uid。 */
  countAccount?: boolean;
  policy?: LoginPolicy;
};

export type LoginLimitHit = {
  code: 'RATE_LIMITED' | 'PASSWORD_LOGIN_PAUSED';
  retryAfterMs: number;
};

export type LoginLimiterRejectInfo = LoginLimitHit & {
  uid: string;
  ip: string;
  method: LoginMethod;
  peer: boolean;
};

/** 账号软顶的滚动窗口，与 `accountLockMs` 无关。 */
export const LOGIN_ACCOUNT_WINDOW_MS = 60 * 60 * 1000;
/** IP 阶梯只记最近 24 小时内已经发生过的锁定。 */
export const LOGIN_LADDER_WINDOW_MS = 24 * 60 * 60 * 1000;

export function ipLockDurationMs(policy: LoginPolicy, priorLocks: number): number {
  let duration = policy.ipLockBaseMs;
  const steps = priorLocks > 0 ? priorLocks : 0;
  for (let i = 0; i < steps && duration < policy.ipLockMaxMs; i += 1) {
    duration = Math.min(duration * 2, policy.ipLockMaxMs);
  }
  return duration;
}

type IpBucket = {
  failures: number[];
  locks: number[];
  lockUntil: number;
  touched: number;
  lockGen: number;
  /** 正在锁定期内，键在到期堆里，不在空闲序里。 */
  pinned: boolean;
};

type UidBucket = {
  failures: number[];
  pauseUntil: number;
  touched: number;
  pauseGen: number;
  pinned: boolean;
};

export class LoginPolicyLimiter {
  private readonly ips = new Map<string, IpBucket>();
  private readonly uids = new Map<string, UidBucket>();
  private readonly ipIdle = new Map<string, true>();
  private readonly uidIdle = new Map<string, true>();
  private readonly ipLocks = new LockQueue();
  private readonly uidLocks = new LockQueue();
  private ops = 0;
  private readonly maxKeys: number;
  private readonly pruneEvery: number;

  constructor(
    private readonly now: () => number,
    private readonly policyOf: () => LoginPolicy,
    options?: { maxKeys?: number; pruneEvery?: number }
  ) {
    this.maxKeys = options?.maxKeys ?? LOGIN_LIMITER_MAX_KEYS;
    this.pruneEvery = options?.pruneEvery ?? LOGIN_LIMITER_PRUNE_EVERY;
  }

  get size(): number {
    return this.ips.size + this.uids.size;
  }

  check(attempt: LoginLimitAttempt): LoginLimitHit | null {
    if (attempt.exempt) return null;
    const now = this.now();
    const policy = this.policyFor(attempt);
    const ipHit = this.ipHit(attempt.ip, now, policy);
    if (ipHit) return ipHit;
    if (attempt.countAccount === false) return null;
    return this.accountHit(attempt, now);
  }

  recordFailure(attempt: LoginLimitAttempt): void {
    this.noteOp();
    if (attempt.exempt) return;
    const now = this.now();
    const policy = this.policyFor(attempt);
    this.pushIpFailure(attempt.ip, now, policy);
    if (attempt.countAccount !== false) this.pushUidFailure(attempt.uid, now, policy);
  }

  /** 成功只清该 IP 的失败计数，锁定历史保留。 */
  recordSuccess(ip: string): void {
    if (!ip) return;
    const bucket = this.ips.get(ip);
    if (!bucket) return;
    const now = this.now();
    bucket.failures = [];
    bucket.touched = now;
    this.releaseIpLock(ip, bucket, now);
    if (!bucket.pinned) this.ipLocks.touch(this.ipIdle, ip);
    this.dropIpIfIdle(ip, bucket, now);
  }

  private policyFor(attempt: LoginLimitAttempt): LoginPolicy {
    return attempt.policy ?? this.policyOf();
  }

  private ipHit(ip: string, now: number, policy: LoginPolicy): LoginLimitHit | null {
    if (!ip) return null;
    const bucket = this.ips.get(ip);
    if (!bucket) return null;
    this.refreshIp(bucket, now, policy);
    this.releaseIpLock(ip, bucket, now);
    if (bucket.lockUntil > now) {
      return { code: 'RATE_LIMITED', retryAfterMs: bucket.lockUntil - now };
    }
    this.dropIpIfIdle(ip, bucket, now);
    return null;
  }

  private accountHit(attempt: LoginLimitAttempt, now: number): LoginLimitHit | null {
    if (attempt.method !== 'root' || !attempt.uid) return null;
    const bucket = this.uids.get(attempt.uid);
    if (!bucket) return null;
    bucket.failures = liveSince(bucket.failures, now, LOGIN_ACCOUNT_WINDOW_MS);
    this.releaseUidPause(attempt.uid, bucket, now);
    if (bucket.pauseUntil <= now) {
      this.dropUidIfIdle(attempt.uid, bucket, now);
      return null;
    }
    return { code: 'PASSWORD_LOGIN_PAUSED', retryAfterMs: bucket.pauseUntil - now };
  }

  private pushIpFailure(ip: string, now: number, policy: LoginPolicy): void {
    if (!ip) return;
    const bucket = this.ipBucket(ip, now);
    if (bucket.lockUntil > now) return;
    this.releaseIpLock(ip, bucket, now);
    bucket.failures = liveSince(bucket.failures, now, policy.ipLockBaseMs);
    bucket.failures.push(now);
    bucket.touched = now;
    if (bucket.failures.length < policy.ipFailThreshold) return;
    bucket.locks = liveSince(bucket.locks, now, LOGIN_LADDER_WINDOW_MS);
    bucket.lockUntil = now + ipLockDurationMs(policy, bucket.locks.length);
    bucket.locks.push(now);
    bucket.failures = [];
    this.holdIpLock(ip, bucket);
  }

  private pushUidFailure(uid: string, now: number, policy: LoginPolicy): void {
    if (!uid) return;
    const bucket = this.uidBucket(uid, now);
    if (bucket.pauseUntil > now) return;
    this.releaseUidPause(uid, bucket, now);
    bucket.failures = liveSince(bucket.failures, now, LOGIN_ACCOUNT_WINDOW_MS);
    bucket.failures.push(now);
    bucket.touched = now;
    if (bucket.failures.length <= policy.accountFailPerHour) return;
    bucket.pauseUntil = now + policy.accountLockMs;
    // 暂停一开始就清空窗口，到期后必须重新攒够次数，不能靠残留失败再锁一次。
    bucket.failures = [];
    this.holdUidPause(uid, bucket);
  }

  private refreshIp(bucket: IpBucket, now: number, policy: LoginPolicy): void {
    bucket.failures = liveSince(bucket.failures, now, policy.ipLockBaseMs);
    bucket.locks = liveSince(bucket.locks, now, LOGIN_LADDER_WINDOW_MS);
  }

  private ipBucket(ip: string, now: number): IpBucket {
    const existing = this.ips.get(ip);
    if (existing) {
      existing.touched = now;
      if (!existing.pinned) this.ipLocks.touch(this.ipIdle, ip);
      return existing;
    }
    this.makeIpRoom();
    const created: IpBucket = {
      failures: [],
      locks: [],
      lockUntil: 0,
      touched: now,
      lockGen: 0,
      pinned: false,
    };
    this.ips.set(ip, created);
    this.ipLocks.touch(this.ipIdle, ip);
    return created;
  }

  private uidBucket(uid: string, now: number): UidBucket {
    const existing = this.uids.get(uid);
    if (existing) {
      existing.touched = now;
      if (!existing.pinned) this.uidLocks.touch(this.uidIdle, uid);
      return existing;
    }
    this.makeUidRoom();
    const created: UidBucket = {
      failures: [],
      pauseUntil: 0,
      touched: now,
      pauseGen: 0,
      pinned: false,
    };
    this.uids.set(uid, created);
    this.uidLocks.touch(this.uidIdle, uid);
    return created;
  }

  private dropIpIfIdle(ip: string, bucket: IpBucket, now: number): void {
    if (bucket.pinned || bucket.lockUntil > now) return;
    if (bucket.failures.length > 0 || bucket.locks.length > 0) return;
    this.forgetIp(ip);
  }

  private dropUidIfIdle(uid: string, bucket: UidBucket, now: number): void {
    if (bucket.pinned || bucket.pauseUntil > now) return;
    if (bucket.failures.length > 0) return;
    this.forgetUid(uid);
  }

  private noteOp(): void {
    this.ops += 1;
    if (this.pruneEvery > 0 && this.ops % this.pruneEvery === 0) this.sweep();
  }

  private sweep(): void {
    const now = this.now();
    const policy = this.policyOf();
    for (const [ip, bucket] of this.ips) {
      this.refreshIp(bucket, now, policy);
      this.releaseIpLock(ip, bucket, now);
      this.dropIpIfIdle(ip, bucket, now);
    }
    for (const [uid, bucket] of this.uids) {
      bucket.failures = liveSince(bucket.failures, now, LOGIN_ACCOUNT_WINDOW_MS);
      this.releaseUidPause(uid, bucket, now);
      this.dropUidIfIdle(uid, bucket, now);
    }
    this.ipLocks.rebuild(
      liveLocks(
        this.ips,
        now,
        (bucket) => bucket.lockUntil,
        (bucket) => bucket.lockGen
      )
    );
    this.uidLocks.rebuild(
      liveLocks(
        this.uids,
        now,
        (bucket) => bucket.pauseUntil,
        (bucket) => bucket.pauseGen
      )
    );
  }

  private makeIpRoom(): void {
    this.evictOver(
      this.ips,
      this.ipLocks,
      this.ipIdle,
      (key, gen) => this.ipLive(key, gen),
      (key) => this.forgetIp(key)
    );
  }

  private makeUidRoom(): void {
    this.evictOver(
      this.uids,
      this.uidLocks,
      this.uidIdle,
      (key, gen) => this.uidLive(key, gen),
      (key) => this.forgetUid(key)
    );
  }

  /** 空闲桶按 Map 插入序淘汰；没有空闲桶时丢掉到期最早的锁。两边都是 O(1) 或 O(log n)，不扫全表。 */
  private evictOver(
    map: Map<string, unknown>,
    queue: LockQueue,
    idle: Map<string, true>,
    live: (key: string, gen: number) => boolean,
    forget: (key: string) => void
  ): void {
    let guard = map.size + 1;
    while (map.size >= this.maxKeys && guard > 0) {
      guard -= 1;
      const victim = queue.take(idle, live);
      if (victim === null) return;
      const before = map.size;
      forget(victim);
      if (map.size >= before) return;
    }
  }

  private ipLive(key: string, gen: number): boolean {
    const bucket = this.ips.get(key);
    return bucket?.pinned === true && bucket.lockGen === gen;
  }

  private uidLive(key: string, gen: number): boolean {
    const bucket = this.uids.get(key);
    return bucket?.pinned === true && bucket.pauseGen === gen;
  }

  private holdIpLock(ip: string, bucket: IpBucket): void {
    bucket.pinned = true;
    bucket.lockGen += 1;
    this.ipLocks.arm(this.ipIdle, ip, bucket.lockUntil, bucket.lockGen);
  }

  private holdUidPause(uid: string, bucket: UidBucket): void {
    bucket.pinned = true;
    bucket.pauseGen += 1;
    this.uidLocks.arm(this.uidIdle, uid, bucket.pauseUntil, bucket.pauseGen);
  }

  private releaseIpLock(ip: string, bucket: IpBucket, now: number): void {
    if (!bucket.pinned || bucket.lockUntil > now) return;
    bucket.pinned = false;
    bucket.lockGen += 1;
    this.ipLocks.touch(this.ipIdle, ip);
  }

  private releaseUidPause(uid: string, bucket: UidBucket, now: number): void {
    if (!bucket.pinned || bucket.pauseUntil > now) return;
    bucket.pinned = false;
    bucket.pauseGen += 1;
    this.uidLocks.touch(this.uidIdle, uid);
  }

  private forgetIp(ip: string): void {
    const bucket = this.ips.get(ip);
    if (bucket) {
      bucket.pinned = false;
      bucket.lockGen += 1;
    }
    this.ips.delete(ip);
    this.ipIdle.delete(ip);
  }

  private forgetUid(uid: string): void {
    const bucket = this.uids.get(uid);
    if (bucket) {
      bucket.pinned = false;
      bucket.pauseGen += 1;
    }
    this.uids.delete(uid);
    this.uidIdle.delete(uid);
  }
}

function liveSince(times: number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs;
  let start = 0;
  while (start < times.length && (times[start] ?? 0) <= cutoff) start += 1;
  return start === 0 ? times : times.slice(start);
}

function liveLocks<T extends { pinned: boolean }>(
  map: Map<string, T>,
  now: number,
  untilOf: (bucket: T) => number,
  genOf: (bucket: T) => number
): LockTicket[] {
  const tickets: LockTicket[] = [];
  for (const [key, bucket] of map) {
    if (!bucket.pinned || untilOf(bucket) <= now) continue;
    tickets.push({ key, until: untilOf(bucket), gen: genOf(bucket) });
  }
  return tickets;
}
