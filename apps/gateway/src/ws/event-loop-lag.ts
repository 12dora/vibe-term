import { envInt, stamp } from '../mesh/mesh-log';

export const EVENT_LOOP_LAG_TICK_MS = 1_000;
export const EVENT_LOOP_LAG_WINDOW_MS = 30_000;
export const EVENT_LOOP_LAG_WARN_MS_DEFAULT = 250;
export const EVENT_LOOP_LAG_WARN_INTERVAL_MS = 10_000;

export type EventLoopLagSnapshot = {
  lagMs: number;
  maxLagMs: number;
};

export type EventLoopLagSamplerOptions = {
  now?: () => number;
  tickMs?: number;
  windowMs?: number;
  warnMs?: number;
  warnIntervalMs?: number;
  warn?: (line: string) => void;
  schedule?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  unschedule?: (id: ReturnType<typeof setTimeout>) => void;
};

type Sample = { at: number; lag: number };

export class EventLoopLagSampler {
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly windowMs: number;
  private readonly warnMs: number;
  private readonly warnIntervalMs: number;
  private readonly warn: (line: string) => void;
  private readonly schedule: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly unschedule: (id: ReturnType<typeof setTimeout>) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expectedAt = 0;
  private lagMs = 0;
  private lastWarnAt = Number.NEGATIVE_INFINITY;
  private readonly samples: Sample[] = [];

  constructor(opts: EventLoopLagSamplerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? EVENT_LOOP_LAG_TICK_MS;
    this.windowMs = opts.windowMs ?? EVENT_LOOP_LAG_WINDOW_MS;
    this.warnMs =
      opts.warnMs ?? envInt('TMEX_EVENT_LOOP_LAG_WARN_MS', EVENT_LOOP_LAG_WARN_MS_DEFAULT);
    this.warnIntervalMs = opts.warnIntervalMs ?? EVENT_LOOP_LAG_WARN_INTERVAL_MS;
    this.warn =
      opts.warn ??
      ((line) => {
        console.warn(stamp(line));
      });
    this.schedule = opts.schedule ?? ((cb, ms) => setTimeout(cb, ms));
    this.unschedule = opts.unschedule ?? ((id) => clearTimeout(id));
  }

  start(): void {
    if (this.timer) return;
    this.expectedAt = this.now() + this.tickMs;
    this.arm();
  }

  stop(): void {
    if (!this.timer) return;
    this.unschedule(this.timer);
    this.timer = null;
  }

  snapshot(): EventLoopLagSnapshot {
    this.prune(this.now());
    return { lagMs: this.lagMs, maxLagMs: this.maxLag() };
  }

  tick(): void {
    const now = this.now();
    const lag = Math.max(0, now - this.expectedAt);
    this.lagMs = lag;
    this.samples.push({ at: now, lag });
    this.prune(now);
    if (lag >= this.warnMs && now - this.lastWarnAt >= this.warnIntervalMs) {
      this.lastWarnAt = now;
      const maxLagMs = this.maxLag();
      this.warn(
        `[ws-metrics] event_loop_lag lag_ms=${lag} max_lag_ms=${maxLagMs} warn_ms=${this.warnMs}`
      );
    }
    this.expectedAt = now + this.tickMs;
    this.arm();
  }

  private arm(): void {
    this.timer = this.schedule(() => this.tick(), this.tickMs);
    this.timer?.unref?.();
  }

  private prune(now: number): void {
    const floor = now - this.windowMs;
    while (this.samples.length > 0 && (this.samples[0]?.at ?? 0) <= floor) {
      this.samples.shift();
    }
  }

  private maxLag(): number {
    let max = this.lagMs;
    for (const sample of this.samples) {
      if (sample.lag > max) max = sample.lag;
    }
    return max;
  }
}

let shared: EventLoopLagSampler | null = null;

export function gatewayEventLoopLag(): EventLoopLagSampler {
  if (!shared) {
    shared = new EventLoopLagSampler();
    shared.start();
  }
  return shared;
}

export function stopGatewayEventLoopLagForTest(): void {
  shared?.stop();
  shared = null;
}
