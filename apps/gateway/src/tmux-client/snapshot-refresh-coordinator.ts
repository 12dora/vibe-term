export const SNAPSHOT_REFRESH_QUIET_PERIOD_MS = 150;

type CoordinatorPhase = 'idle' | 'waiting' | 'refreshing';

export class SnapshotRefreshCoordinator {
  private active: Promise<void> | null = null;
  private trailingRequested = false;
  private trailingImmediate = false;
  private lastRefreshAt: number | null = null;
  private cancelQuiet: (() => void) | null = null;
  private phase: CoordinatorPhase = 'idle';
  private skipQuiet = false;
  private readonly quietPeriodMs: number;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;

  constructor(
    private readonly refresh: () => Promise<void>,
    options: {
      quietPeriodMs?: number;
      now?: () => number;
      delay?: (ms: number) => Promise<void>;
    } = {}
  ) {
    this.quietPeriodMs = options.quietPeriodMs ?? SNAPSHOT_REFRESH_QUIET_PERIOD_MS;
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  request(): Promise<void> {
    return this.enqueue(false);
  }

  requestImmediate(): Promise<void> {
    if (this.active && this.phase !== 'refreshing') {
      this.skipQuiet = true;
      this.cancelQuiet?.();
      return this.active;
    }
    return this.enqueue(true);
  }

  private enqueue(immediate: boolean): Promise<void> {
    if (this.active) {
      if (this.phase === 'refreshing') {
        this.trailingRequested = true;
        if (immediate) this.trailingImmediate = true;
      }
      return this.active;
    }

    this.trailingRequested = false;
    this.trailingImmediate = false;
    this.skipQuiet = immediate;
    this.phase = 'waiting';
    const active = Promise.resolve().then(async () => {
      try {
        while (true) {
          if (!this.skipQuiet) {
            await this.waitQuiet();
          }
          this.skipQuiet = false;
          this.phase = 'refreshing';
          await this.refresh();
          this.lastRefreshAt = this.now();
          if (!this.trailingRequested) {
            break;
          }
          const nextImmediate = this.trailingImmediate;
          this.trailingRequested = false;
          this.trailingImmediate = false;
          this.skipQuiet = nextImmediate;
          this.phase = 'waiting';
        }
      } finally {
        this.phase = 'idle';
        this.active = null;
      }
    });
    this.active = active;
    return active;
  }

  private remainingQuiet(): number {
    if (this.lastRefreshAt === null || this.quietPeriodMs <= 0) return 0;
    return Math.max(0, this.quietPeriodMs - (this.now() - this.lastRefreshAt));
  }

  private waitQuiet(): Promise<void> {
    const remaining = this.remainingQuiet();
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.cancelQuiet = null;
        resolve();
      };
      this.cancelQuiet = done;
      void this.delay(remaining).then(done);
    });
  }
}
