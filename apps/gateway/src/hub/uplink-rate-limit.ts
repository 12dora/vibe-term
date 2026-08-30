export const HUB_KEY_LOG_REQ_RATE_PER_MIN = 10;
export const HUB_KEY_LOG_REQ_BURST = 20;
export const HUB_KEY_LOG_REQ_STATE_MAX = 1024;
export const HUB_KEY_LOG_REQ_IDLE_TTL_MS = 10 * 60 * 1000;
export const HUB_KEY_LOG_REQ_OVERFLOW_MAX_USERS = 256;
export const HUB_KEY_LOG_REQ_OVERFLOW_MAX_NODES = 8;
export const HUB_KEY_LOG_REQ_RETRY_AFTER_MS = 6_000;

export class TokenBucket {
  private tokens: number;
  private lastMs = 0;

  constructor(
    private readonly ratePerMin: number,
    private readonly burst: number
  ) {
    this.tokens = burst;
  }

  take(now: number): boolean {
    if (this.lastMs === 0) {
      this.lastMs = now;
    } else {
      const elapsed = Math.max(0, now - this.lastMs);
      this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.ratePerMin) / 60_000);
      this.lastMs = now;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class IdleLruMap<T> {
  private readonly items = new Map<string, { value: T; lastAt: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number
  ) {}

  get size(): number {
    return this.items.size;
  }

  get(key: string, now: number): T | undefined {
    this.sweep(now);
    return this.items.get(key)?.value;
  }

  touch(key: string, now: number): T | undefined {
    this.sweep(now);
    const row = this.items.get(key);
    if (!row) return undefined;
    row.lastAt = now;
    this.items.delete(key);
    this.items.set(key, row);
    return row.value;
  }

  set(key: string, value: T, now: number): T {
    this.sweep(now);
    this.items.delete(key);
    this.items.set(key, { value, lastAt: now });
    while (this.items.size > this.max) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
    return value;
  }

  trySet(key: string, value: T, now: number): T | undefined {
    this.sweep(now);
    if (this.items.has(key)) {
      this.items.delete(key);
      this.items.set(key, { value, lastAt: now });
      return value;
    }
    if (this.items.size >= this.max) return undefined;
    this.items.set(key, { value, lastAt: now });
    return value;
  }

  delete(key: string): void {
    this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }

  sweep(now: number): void {
    for (const [key, row] of this.items) {
      if (now - row.lastAt >= this.ttlMs) this.items.delete(key);
    }
  }
}

export class WindowedLogBudget {
  private stamps: number[] = [];
  private suppressed = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  prune(now: number): void {
    const cutoff = now - this.windowMs;
    const oldest = this.stamps[0];
    if (oldest !== undefined && oldest <= cutoff) {
      this.stamps = this.stamps.filter((stamp) => stamp > cutoff);
    }
  }

  wouldAllow(now: number): boolean {
    this.prune(now);
    return this.stamps.length < this.max;
  }

  suppress(): void {
    this.suppressed += 1;
  }

  take(now: number): number {
    this.prune(now);
    this.stamps.push(now);
    const flushed = this.suppressed;
    this.suppressed = 0;
    return flushed;
  }

  clear(): void {
    this.stamps.length = 0;
    this.suppressed = 0;
  }
}

type OverflowUser = {
  lastAt: number;
  nodes: Map<string, { bucket: TokenBucket; lastAt: number }>;
};

export class KeyLogReqLimiter {
  private readonly buckets: IdleLruMap<TokenBucket>;
  private readonly overflow = new Map<string, OverflowUser>();
  private readonly ratePerMin: number;
  private readonly burst: number;
  private readonly ttlMs: number;
  private readonly overflowMaxUsers: number;
  private readonly overflowMaxNodes: number;
  private deniedCount = 0;
  private lastRetryAfterMs = HUB_KEY_LOG_REQ_RETRY_AFTER_MS;

  constructor(opts?: {
    max?: number;
    ttlMs?: number;
    ratePerMin?: number;
    burst?: number;
    overflowMaxUsers?: number;
    overflowMaxNodes?: number;
  }) {
    this.ratePerMin = opts?.ratePerMin ?? HUB_KEY_LOG_REQ_RATE_PER_MIN;
    this.burst = opts?.burst ?? HUB_KEY_LOG_REQ_BURST;
    this.ttlMs = opts?.ttlMs ?? HUB_KEY_LOG_REQ_IDLE_TTL_MS;
    this.overflowMaxUsers = opts?.overflowMaxUsers ?? HUB_KEY_LOG_REQ_OVERFLOW_MAX_USERS;
    this.overflowMaxNodes = opts?.overflowMaxNodes ?? HUB_KEY_LOG_REQ_OVERFLOW_MAX_NODES;
    this.buckets = new IdleLruMap(opts?.max ?? HUB_KEY_LOG_REQ_STATE_MAX, this.ttlMs);
  }

  get primarySize(): number {
    return this.buckets.size;
  }

  get size(): number {
    let extra = 0;
    for (const user of this.overflow.values()) extra += 1 + user.nodes.size;
    return this.primarySize + extra;
  }

  get overflowUsers(): number {
    return this.overflow.size;
  }

  get overflowNodes(): number {
    let n = 0;
    for (const user of this.overflow.values()) n += user.nodes.size;
    return n;
  }

  get denied(): number {
    return this.deniedCount;
  }

  get retryAfterMs(): number {
    return this.lastRetryAfterMs;
  }

  take(nodeId: string, userId: string, now: number): boolean {
    this.sweepOverflow(now);
    let bucket = this.buckets.touch(nodeId, now);
    if (!bucket) {
      const created = new TokenBucket(this.ratePerMin, this.burst);
      bucket = this.buckets.trySet(nodeId, created, now);
      if (!bucket) {
        bucket = this.takeOverflow(nodeId, userId, now);
      }
    }
    if (!bucket) {
      this.deniedCount += 1;
      this.lastRetryAfterMs = this.ttlMs;
      return false;
    }
    const ok = bucket.take(now);
    if (!ok) {
      this.deniedCount += 1;
      this.lastRetryAfterMs =
        this.ratePerMin > 0 ? Math.ceil(60_000 / this.ratePerMin) : this.ttlMs;
    }
    return ok;
  }

  delete(nodeId: string): void {
    this.buckets.delete(nodeId);
    for (const [userId, user] of this.overflow) {
      user.nodes.delete(nodeId);
      if (user.nodes.size === 0) this.overflow.delete(userId);
    }
  }

  clear(): void {
    this.buckets.clear();
    this.overflow.clear();
    this.deniedCount = 0;
  }

  private takeOverflow(nodeId: string, userId: string, now: number): TokenBucket | undefined {
    let user = this.overflow.get(userId);
    if (!user) {
      while (this.overflow.size >= this.overflowMaxUsers) {
        const oldest = this.overflow.keys().next().value;
        if (oldest === undefined) break;
        this.overflow.delete(oldest);
      }
      user = {
        lastAt: now,
        nodes: new Map(),
      };
    }
    user.lastAt = now;
    this.overflow.delete(userId);
    this.overflow.set(userId, user);

    let node = user.nodes.get(nodeId);
    if (!node) {
      if (user.nodes.size >= this.overflowMaxNodes) {
        return undefined;
      }
      node = { bucket: new TokenBucket(this.ratePerMin, this.burst), lastAt: now };
    }
    node.lastAt = now;
    user.nodes.delete(nodeId);
    user.nodes.set(nodeId, node);
    return node.bucket;
  }

  private sweepOverflow(now: number): void {
    for (const [userId, user] of this.overflow) {
      if (now - user.lastAt >= this.ttlMs) {
        this.overflow.delete(userId);
        continue;
      }
      for (const [nodeId, node] of user.nodes) {
        if (now - node.lastAt >= this.ttlMs) user.nodes.delete(nodeId);
      }
    }
  }
}
