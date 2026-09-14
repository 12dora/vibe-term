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
