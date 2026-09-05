export type SlidingWindowEviction = 'oldest' | 'expired-only';

export type SlidingWindowOptions = {
  windowMs: number;
  now?: () => number;
  maxKeys?: number;
  evict?: SlidingWindowEviction;
};

/**
 * 按 key 记时间戳列表的滑动窗口计数器。`evict` 决定超过 `maxKeys` 时的取舍：
 * `expired-only` 只回收窗口已过期的桶（仍在窗口内或已触达上限的桶永不被挤掉），
 * `oldest` 在回收过期桶后仍超限时，继续按最早一次命中的时间驱逐。
 */
export class SlidingWindowCounter {
  private readonly buckets = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly eviction: SlidingWindowEviction;
  private readonly clock: () => number;

  constructor(options: SlidingWindowOptions) {
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? Number.POSITIVE_INFINITY;
    this.eviction = options.evict ?? 'oldest';
    this.clock = options.now ?? Date.now;
  }

  get size(): number {
    return this.buckets.size;
  }

  count(key: string, now = this.clock()): number {
    return this.retain(key, this.live(key, now)).length;
  }

  hit(key: string, now = this.clock()): number {
    const next = this.live(key, now);
    next.push(now);
    this.buckets.set(key, next);
    if (this.buckets.size > this.maxKeys) this.sweep(now);
    return next.length;
  }

  /** 撤销一次刚记下的命中（预留式限流回滚）。 */
  release(key: string): boolean {
    const times = this.buckets.get(key);
    if (!times || times.length === 0) return false;
    times.pop();
    this.retain(key, times);
    return true;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }

  sweep(now = this.clock()): void {
    for (const [key, times] of this.buckets) {
      this.retain(key, prune(times, now, this.windowMs));
    }
    if (this.eviction === 'expired-only') return;
    while (this.buckets.size > this.maxKeys) {
      const victim = this.oldestKey();
      if (victim === null) break;
      this.buckets.delete(victim);
    }
  }

  private live(key: string, now: number): number[] {
    return prune(this.buckets.get(key) ?? [], now, this.windowMs);
  }

  private retain(key: string, times: number[]): number[] {
    if (times.length === 0) this.buckets.delete(key);
    else this.buckets.set(key, times);
    return times;
  }

  private oldestKey(): string | null {
    let oldestKey: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, times] of this.buckets) {
      const first = times[0] ?? Number.NEGATIVE_INFINITY;
      if (first < oldest) {
        oldest = first;
        oldestKey = key;
      }
    }
    return oldestKey;
  }
}

function prune(times: number[], now: number, windowMs: number): number[] {
  return times.filter((at) => now - at < windowMs);
}
