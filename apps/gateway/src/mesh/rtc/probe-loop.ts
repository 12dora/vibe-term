export type ProbeLoopRow = {
  url: string;
  ok: boolean;
  rttMs: number;
  error?: string;
  skipped?: string;
};

export type ProbeLoopRecord<T extends ProbeLoopRow = ProbeLoopRow> = T & { probedAt: number };

export type ProbeLoopDeps<T extends ProbeLoopRow = ProbeLoopRow> = {
  probeAll?: (urls: readonly string[]) => Promise<T[]>;
  now?: () => number;
  random?: () => number;
  minIntervalMs?: number;
};

export type ProbeScheduler = { interval(fn: () => void, ms: number): { clear: () => void } };

export type ProbeLoopKind<TRtc, T extends ProbeLoopRow> = {
  intervalMs: number;
  defaultMinIntervalMs: number;
  urlsOf: (rtc: TRtc) => string[];
  defaultProbeAll: (
    urls: readonly string[],
    signal: AbortSignal,
    now?: () => number
  ) => Promise<T[]>;
  applyResults?: (records: ProbeLoopRecord<T>[]) => void;
  logBatch: (records: ProbeLoopRecord<T>[]) => void;
};

export function probeListKey(urls: readonly string[]): string {
  return [...urls].sort().join('\0');
}

export function jitteredProbeIntervalMs(intervalMs: number, random: () => number): number {
  return Math.round(intervalMs * (1 + (random() * 2 - 1) * 0.1));
}

export function failedAttemptedProbes<T extends { ok: boolean; skipped?: string }>(
  results: readonly T[]
): T[] | null {
  const attempted = results.filter((row) => !row.skipped);
  if (attempted.length === 0 || attempted.some((row) => row.ok)) return null;
  return attempted;
}

export class MeshProbeLoop<TRtc, T extends ProbeLoopRow> {
  lastResults: ProbeLoopRecord<T>[] = [];
  private lastKey: string | null = null;
  private lastCycleAt = 0;
  private inflight: Promise<void> | null = null;
  private queued: string[] | null = null;
  private pending: string[] | null = null;
  private tick: { clear: () => void } | null = null;
  private waitH: { clear: () => void } | null = null;
  private readonly ac = new AbortController();
  private stopped = false;
  private armed = false;

  constructor(
    private readonly rtc: TRtc,
    private readonly scheduler: ProbeScheduler,
    private readonly opts: ProbeLoopDeps<T>,
    private readonly kind: ProbeLoopKind<TRtc, T>
  ) {}

  start(): void {
    void this.runCycle(this.kind.urlsOf(this.rtc));
    this.armTick();
  }

  stop(): void {
    this.stopped = true;
    this.ac.abort();
    this.tick?.clear();
    this.waitH?.clear();
    this.tick = this.waitH = null;
    this.queued = this.pending = null;
  }

  sync(rtc: TRtc): void {
    const urls = this.kind.urlsOf(rtc);
    if (probeListKey(urls) === this.lastKey) return;
    const min = this.opts.minIntervalMs ?? this.kind.defaultMinIntervalMs;
    const elapsed = (this.opts.now ?? Date.now)() - this.lastCycleAt;
    if (this.lastCycleAt > 0 && elapsed < min) {
      this.armWait(urls, min - elapsed);
      return;
    }
    void this.runCycle(urls);
  }

  private armTick(): void {
    if (this.stopped || this.armed) return;
    this.armed = true;
    const rand = this.opts.random ?? Math.random;
    const ms = jitteredProbeIntervalMs(this.kind.intervalMs, rand);
    this.tick = this.scheduler.interval(() => {
      if (!this.stopped) void this.runCycle(this.kind.urlsOf(this.rtc));
    }, ms);
  }

  private armWait(urls: string[], ms: number): void {
    if (this.stopped) return;
    this.pending = urls;
    this.waitH?.clear();
    this.waitH = this.scheduler.interval(() => {
      this.waitH?.clear();
      this.waitH = null;
      const next = this.pending ?? this.kind.urlsOf(this.rtc);
      this.pending = null;
      if (!this.stopped && probeListKey(next) !== this.lastKey) void this.runCycle(next);
    }, ms);
  }

  private runCycle(urls: string[]): Promise<void> {
    if (this.inflight) {
      this.queued = urls;
      return this.inflight;
    }
    this.inflight = this.loop(urls)
      .catch(() => {})
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async loop(urls: string[]): Promise<void> {
    let current = urls;
    const clock = this.opts.now ?? Date.now;
    const probeAll =
      this.opts.probeAll ??
      ((list: readonly string[]) => this.kind.defaultProbeAll(list, this.ac.signal, this.opts.now));
    for (;;) {
      if (this.stopped || this.ac.signal.aborted) return;
      this.lastKey = probeListKey(current);
      this.lastCycleAt = clock();
      if (process.env.NODE_ENV === 'test' && !this.opts.probeAll) return;
      let results: T[];
      try {
        results = await probeAll(current);
      } catch {
        results = current.map((url) => ({ url, ok: false, rttMs: 0, error: 'error' }) as T);
      }
      if (this.stopped) return;
      this.storeCycle(results, clock);
      const next = this.takeQueued();
      if (!next) return;
      current = next;
    }
  }

  private storeCycle(results: T[], clock: () => number): void {
    const records = results.map((row) => ({ ...row, probedAt: clock() }));
    this.lastResults = records;
    this.kind.applyResults?.(records);
    try {
      this.kind.logBatch(records);
    } catch {}
  }

  private takeQueued(): string[] | null {
    if (!this.queued) return null;
    const current = this.queued;
    this.queued = null;
    if (probeListKey(current) === this.lastKey) return null;
    const min = this.opts.minIntervalMs ?? this.kind.defaultMinIntervalMs;
    const wait = min - ((this.opts.now ?? Date.now)() - this.lastCycleAt);
    if (wait > 0) {
      this.armWait(current, wait);
      return null;
    }
    return current;
  }
}
