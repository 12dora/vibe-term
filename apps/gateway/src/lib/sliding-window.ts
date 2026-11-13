export type SlidingWindowEviction = 'oldest';

export type SlidingWindowOptions = {
  windowMs: number;
  now?: () => number;
  maxKeys?: number;
  /** 唯一的驱逐策略；保留字段只为让调用方显式写明。 */
  evict?: SlidingWindowEviction;
};

/**
 * 按 key 记时间戳列表的滑动窗口计数器。超过 `maxKeys` 时先回收队首附近已过期的桶，
 * 没有就驱逐最早开始计数的桶（Map 插入序即开始序），单次命中的代价有上界，key 数也有上界。
 */
export class SlidingWindowCounter {
  private readonly buckets = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly clock: () => number;

  constructor(options: SlidingWindowOptions) {
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? Number.POSITIVE_INFINITY;
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
    while (this.buckets.size > this.maxKeys) this.evictOne(key, now);
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

  /** 该 key 最早一次仍有效命中距窗口结束的剩余毫秒；无命中为 0。 */
  retryAfterMs(key: string, now = this.clock()): number {
    const first = this.live(key, now)[0];
    if (first === undefined) return 0;
    return Math.max(0, first + this.windowMs - now);
  }

  clear(): void {
    this.buckets.clear();
  }

  sweep(now = this.clock()): void {
    for (const [key, times] of this.buckets) {
      this.retain(key, prune(times, now, this.windowMs));
    }
  }

  /** 从队首起最多看 `EVICT_SCAN` 个桶：有过期的先回收，否则驱逐队首（最早开始计数的那个）。 */
  private evictOne(keep: string, now: number): void {
    let victim: string | null = null;
    let scanned = 0;
    for (const [key, times] of this.buckets) {
      if (key === keep) continue;
      if (victim === null) victim = key;
      if (prune(times, now, this.windowMs).length === 0) {
        this.buckets.delete(key);
        return;
      }
      scanned += 1;
      if (scanned >= EVICT_SCAN) break;
    }
    if (victim === null) return;
    this.buckets.delete(victim);
  }

  private live(key: string, now: number): number[] {
    return prune(this.buckets.get(key) ?? [], now, this.windowMs);
  }

  private retain(key: string, times: number[]): number[] {
    if (times.length === 0) this.buckets.delete(key);
    else this.buckets.set(key, times);
    return times;
  }
}

const EVICT_SCAN = 16;

function prune(times: number[], now: number, windowMs: number): number[] {
  return times.filter((at) => now - at < windowMs);
}
