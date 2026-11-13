import { SlidingWindowCounter } from '../lib/sliding-window';
import { limiterIpKey } from '../mesh/client-ip';
import {
  RELAY_ENROLL_CREATE_LIMIT,
  RELAY_ENROLL_CREATE_WINDOW_MS,
  RELAY_ENROLL_FAILURE_LIMIT,
  RELAY_ENROLL_FAILURE_WINDOW_MS,
} from './types';

export const RELAY_ENROLL_LIMITER_MAX_KEYS = 4096;
/** 全中继同时在算的口令 KDF 上限（argon2id 64 MiB 跑在主线程）；再多直接 429，不排队。 */
export const RELAY_KDF_MAX_IN_FLIGHT = 2;
/** 全中继每窗口最多起这么多次口令 KDF：把主线程被 KDF 占用的比例压在一个上界内。 */
export const RELAY_KDF_RATE_LIMIT = 30;
export const RELAY_KDF_RATE_WINDOW_MS = 60_000;
const RELAY_KDF_BUSY_RETRY_MS = 1_000;
const GLOBAL_KDF_KEY = 'kdf';

export type RelayKdfReservation =
  | { ok: true; done: (passwordOk: boolean) => void }
  | { ok: false; retryAfterMs: number };

/**
 * 未鉴权入口（enroll / join / kdf / 改口令）的失败计数，按 `limiterIpKey`（IPv4 原址、IPv6 取 /64）分桶。
 *
 * - 只有按 IP 的桶会拒绝请求；按租户的计数只是告警（匿名失败不能锁住某个租户的加入与恢复）。
 * - 口令 KDF 走 `reserveKdf`：开算**之前**先记一次失败（成功再清掉），同一 IP 同时只允许一个在算，
 *   全中继另有并发与速率上限。
 */
export class RelayEnrollLimiter {
  private readonly failures: SlidingWindowCounter;
  private readonly tenantAlerts: SlidingWindowCounter;
  private readonly kdfRate: SlidingWindowCounter;
  private readonly kdfInFlight = new Set<string>();

  constructor(
    now: () => number = Date.now,
    private readonly limit = RELAY_ENROLL_FAILURE_LIMIT,
    windowMs = RELAY_ENROLL_FAILURE_WINDOW_MS,
    maxKeys = RELAY_ENROLL_LIMITER_MAX_KEYS,
    private readonly log: (line: string) => void = console.warn
  ) {
    this.failures = new SlidingWindowCounter({ windowMs, now, maxKeys, evict: 'oldest' });
    this.tenantAlerts = new SlidingWindowCounter({ windowMs, now, maxKeys, evict: 'oldest' });
    this.kdfRate = new SlidingWindowCounter({ windowMs: RELAY_KDF_RATE_WINDOW_MS, now });
  }

  get size(): number {
    return this.failures.size;
  }

  isLimited(ip: string): boolean {
    return this.count(ip) >= this.limit;
  }

  count(ip: string): number {
    const key = ipKey(ip);
    return key ? this.failures.count(key) : 0;
  }

  recordFailure(ip: string, tenantId?: string): void {
    const key = ipKey(ip);
    if (key) this.failures.hit(key);
    if (tenantId) this.noteTenantFailure(tenantId);
  }

  reset(ip: string): void {
    const key = ipKey(ip);
    if (key) this.failures.reset(key);
  }

  retryAfterMs(ip: string): number {
    const key = ipKey(ip);
    return key ? this.failures.retryAfterMs(key) : 0;
  }

  get kdfInFlightCount(): number {
    return this.kdfInFlight.size;
  }

  reserveKdf(ip: string): RelayKdfReservation {
    const key = ipKey(ip) ?? UNKNOWN_SOURCE_KEY;
    if (this.failures.count(key) >= this.limit) {
      return { ok: false, retryAfterMs: this.failures.retryAfterMs(key) };
    }
    if (this.kdfInFlight.has(key) || this.kdfInFlight.size >= RELAY_KDF_MAX_IN_FLIGHT) {
      return { ok: false, retryAfterMs: RELAY_KDF_BUSY_RETRY_MS };
    }
    if (this.kdfRate.count(GLOBAL_KDF_KEY) >= RELAY_KDF_RATE_LIMIT) {
      return { ok: false, retryAfterMs: this.kdfRate.retryAfterMs(GLOBAL_KDF_KEY) };
    }
    this.kdfRate.hit(GLOBAL_KDF_KEY);
    this.failures.hit(key);
    this.kdfInFlight.add(key);
    let settled = false;
    return {
      ok: true,
      done: (passwordOk) => {
        if (settled) return;
        settled = true;
        this.kdfInFlight.delete(key);
        if (passwordOk) this.failures.reset(key);
      },
    };
  }

  clear(): void {
    this.failures.clear();
    this.tenantAlerts.clear();
    this.kdfRate.clear();
    this.kdfInFlight.clear();
  }

  private noteTenantFailure(tenantId: string): void {
    const count = this.tenantAlerts.hit(tenantKey(tenantId));
    if (count === this.limit) {
      this.log(
        `[relay] repeated join/kdf failures for tenant=${tenantId} count=${count} (alert only, not blocking)`
      );
    }
  }
}

/** 每租户 `relay.enroll.create` 频率闸：滑动窗口计数，`sweep` 回收空桶。 */
export class RelayEnrollCreateRate {
  private readonly marks: SlidingWindowCounter;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limit = RELAY_ENROLL_CREATE_LIMIT,
    windowMs = RELAY_ENROLL_CREATE_WINDOW_MS
  ) {
    this.marks = new SlidingWindowCounter({ windowMs, now });
  }

  allow(tenantId: string): boolean {
    const now = this.now();
    if (this.marks.count(tenantId, now) >= this.limit) return false;
    this.marks.hit(tenantId, now);
    return true;
  }

  sweep(): void {
    this.marks.sweep(this.now());
  }

  clear(): void {
    this.marks.clear();
  }
}

const UNKNOWN_SOURCE_KEY = 'unknown-source';

/** 空地址（取不到来源）不进按 IP 的失败桶，与改动前一致；KDF 预留时仍归到同一个「未知来源」桶。 */
function ipKey(ip: string): string | null {
  return ip ? limiterIpKey(ip) : null;
}

function tenantKey(tenantId: string): string {
  return `tenant:${tenantId}`;
}
