import {
  RELAY_ENROLL_CREATE_LIMIT,
  RELAY_ENROLL_CREATE_WINDOW_MS,
  RELAY_ENROLL_FAILURE_LIMIT,
  RELAY_ENROLL_FAILURE_WINDOW_MS,
} from './types';

export const RELAY_ENROLL_LIMITER_MAX_KEYS = 4096;

/** 按源 IP（及可选租户编号）记 enroll / kdf 失败次数，窗口内累计到上限即拒。 */
export class RelayEnrollLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limit = RELAY_ENROLL_FAILURE_LIMIT,
    private readonly windowMs = RELAY_ENROLL_FAILURE_WINDOW_MS,
    private readonly maxKeys = RELAY_ENROLL_LIMITER_MAX_KEYS
  ) {}

  get size(): number {
    return this.failures.size;
  }

  isLimited(ip: string, tenantId?: string): boolean {
    if (ip && this.count(ip) >= this.limit) return true;
    if (tenantId && this.count(this.tenantKey(tenantId)) >= this.limit) return true;
    return false;
  }

  count(ip: string): number {
    const now = this.now();
    const pruned = (this.failures.get(ip) ?? []).filter((at) => now - at < this.windowMs);
    if (pruned.length === 0) this.failures.delete(ip);
    else this.failures.set(ip, pruned);
    return pruned.length;
  }

  recordFailure(ip: string, tenantId?: string): void {
    if (ip) this.push(ip);
    if (tenantId) this.push(this.tenantKey(tenantId));
  }

  reset(ip: string, tenantId?: string): void {
    this.failures.delete(ip);
    if (tenantId) this.failures.delete(this.tenantKey(tenantId));
  }

  clear(): void {
    this.failures.clear();
  }

  private tenantKey(tenantId: string): string {
    return `tenant:${tenantId}`;
  }

  private push(key: string): void {
    const now = this.now();
    const pruned = (this.failures.get(key) ?? []).filter((at) => now - at < this.windowMs);
    pruned.push(now);
    this.failures.set(key, pruned);
    while (this.failures.size > this.maxKeys) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }
}

/** 每租户 `relay.enroll.create` 频率闸：滑动窗口计数，`sweep` 回收空桶。 */
export class RelayEnrollCreateRate {
  private readonly marks = new Map<string, number[]>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limit = RELAY_ENROLL_CREATE_LIMIT,
    private readonly windowMs = RELAY_ENROLL_CREATE_WINDOW_MS
  ) {}

  allow(tenantId: string): boolean {
    const now = this.now();
    const recent = this.recent(tenantId, now);
    if (recent.length >= this.limit) {
      this.marks.set(tenantId, recent);
      return false;
    }
    recent.push(now);
    this.marks.set(tenantId, recent);
    return true;
  }

  sweep(): void {
    const now = this.now();
    for (const tenantId of [...this.marks.keys()]) this.recent(tenantId, now, true);
  }

  clear(): void {
    this.marks.clear();
  }

  private recent(tenantId: string, now: number, persist = false): number[] {
    const pruned = (this.marks.get(tenantId) ?? []).filter((at) => now - at < this.windowMs);
    if (persist) {
      if (pruned.length === 0) this.marks.delete(tenantId);
      else this.marks.set(tenantId, pruned);
    }
    return pruned;
  }
}
