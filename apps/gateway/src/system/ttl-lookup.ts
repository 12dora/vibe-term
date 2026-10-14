type Entry<T> = { until: number; value: T } | { until: number; error: unknown };

export type TtlLookupPolicy<T> = {
  successTtlMs: (value: T) => number;
  failureTtlMs: (error: unknown) => number;
  maxEntries?: number;
};

/** 带 TTL 的按 key 缓存：成功与失败（负缓存）各自 TTL，同 key 并发调用合并为一次加载。 */
export class TtlLookup<T> {
  private entries = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();
  private generation = 0;

  constructor(private readonly policy: TtlLookupPolicy<T>) {}

  reset(): void {
    this.generation += 1;
    this.entries.clear();
    this.inflight.clear();
  }

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() < hit.until) {
      if ('error' in hit) throw hit.error;
      return hit.value;
    }
    return await (this.inflight.get(key) ?? this.start(key, load));
  }

  private start(key: string, load: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const pending: Promise<T> = load()
      .then(
        (value) => {
          this.store(generation, key, {
            until: Date.now() + this.policy.successTtlMs(value),
            value,
          });
          return value;
        },
        (error: unknown) => {
          this.store(generation, key, {
            until: Date.now() + this.policy.failureTtlMs(error),
            error,
          });
          throw error;
        }
      )
      .finally(() => {
        if (this.inflight.get(key) === pending) this.inflight.delete(key);
      });
    this.inflight.set(key, pending);
    return pending;
  }

  private store(generation: number, key: string, entry: Entry<T>): void {
    if (generation !== this.generation) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    const max = this.policy.maxEntries;
    if (max === undefined) return;
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= max) break;
      this.entries.delete(oldest);
    }
  }
}
