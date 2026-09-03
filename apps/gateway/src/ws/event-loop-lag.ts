import { envInt, stamp } from '../mesh/mesh-log';

export const EVENT_LOOP_LAG_TICK_MS = 1_000;
export const EVENT_LOOP_LAG_IDLE_TICK_MS = 10_000;
export const EVENT_LOOP_LAG_WINDOW_MS = 30_000;
export const EVENT_LOOP_LAG_WARN_MS_DEFAULT = 250;
export const EVENT_LOOP_LAG_WARN_INTERVAL_MS = 10_000;
export const EVENT_LOOP_LAG_FAST_HOLD_MS = 30_000;
export const EVENT_LOOP_LAG_SUSPEND_DRIFT_MS = 2_000;

export type EventLoopLagSnapshot = {
  lagMs: number;
  maxLagMs: number;
  suspendMs: number;
};

export type EventLoopLagSamplerOptions = {
  now?: () => number;
  monotonic?: () => number;
  tickMs?: number;
  idleTickMs?: number;
  windowMs?: number;
  warnMs?: number;
  warnIntervalMs?: number;
  suspendDriftMs?: number;
  diagnostics?: boolean;
  warn?: (line: string) => void;
  schedule?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  unschedule?: (id: ReturnType<typeof setTimeout>) => void;
};

type Sample = { at: number; lag: number };

export class EventLoopLagSampler {
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly fastTickMs: number;
  private readonly idleTickMs: number;
  private readonly windowMs: number;
  private readonly warnMs: number;
  private readonly warnIntervalMs: number;
  private readonly suspendDriftMs: number;
  private readonly diagnostics: boolean;
  private readonly warn: (line: string) => void;
  private readonly schedule: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly unschedule: (id: ReturnType<typeof setTimeout>) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expectedMono = 0;
  private lastWall = 0;
  private lastMono = 0;
  private scheduledTickMs = 0;
  private fastUntil = Number.NEGATIVE_INFINITY;
  private lagMs = 0;
  private suspendMs = 0;
  private lastWarnAt = Number.NEGATIVE_INFINITY;
  private readonly samples: Sample[] = [];

  constructor(opts: EventLoopLagSamplerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.monotonic = opts.monotonic ?? (opts.now ? opts.now : () => performance.now());
    this.fastTickMs = opts.tickMs ?? EVENT_LOOP_LAG_TICK_MS;
    this.idleTickMs = opts.idleTickMs ?? (opts.tickMs ? opts.tickMs : EVENT_LOOP_LAG_IDLE_TICK_MS);
    this.windowMs = opts.windowMs ?? EVENT_LOOP_LAG_WINDOW_MS;
    this.warnMs =
      opts.warnMs ?? envInt('TMEX_EVENT_LOOP_LAG_WARN_MS', EVENT_LOOP_LAG_WARN_MS_DEFAULT);
    this.warnIntervalMs = opts.warnIntervalMs ?? EVENT_LOOP_LAG_WARN_INTERVAL_MS;
    this.suspendDriftMs = opts.suspendDriftMs ?? EVENT_LOOP_LAG_SUSPEND_DRIFT_MS;
    this.diagnostics = opts.diagnostics ?? envInt('TMEX_EVENT_LOOP_LAG_DIAG', 0) > 0;
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
    const wall = this.now();
    const mono = this.monotonic();
    const tick = this.activeTickMs();
    this.lastWall = wall;
    this.lastMono = mono;
    this.expectedMono = mono + tick;
    this.arm();
  }

  stop(): void {
    if (!this.timer) return;
    this.unschedule(this.timer);
    this.timer = null;
  }

  running(): boolean {
    return this.timer !== null;
  }

  demandFast(holdMs = EVENT_LOOP_LAG_FAST_HOLD_MS): void {
    const now = this.now();
    this.fastUntil = Math.max(this.fastUntil, now + holdMs);
    if (!this.timer) return;
    if (this.activeTickMs() === this.scheduledTickMs) return;
    this.unschedule(this.timer);
    this.timer = null;
    const tick = this.activeTickMs();
    this.expectedMono = this.monotonic() + tick;
    this.arm();
  }

  snapshot(): EventLoopLagSnapshot {
    this.prune(this.now());
    this.demandFast();
    return { lagMs: this.lagMs, maxLagMs: this.maxLag(), suspendMs: this.suspendMs };
  }

  tick(): void {
    const wall = this.now();
    const mono = this.monotonic();
    const wallDelta = wall - this.lastWall;
    const monoDelta = mono - this.lastMono;
    const drift = wallDelta - monoDelta;
    const lagFromMono = Math.max(0, Math.round(mono - this.expectedMono));
    this.lastWall = wall;
    this.lastMono = mono;
    if (drift >= this.suspendDriftMs) {
      this.suspendMs = Math.max(0, Math.round(drift));
      this.lagMs = 0;
      this.samples.push({ at: wall, lag: 0 });
    } else {
      this.suspendMs = 0;
      this.lagMs = lagFromMono;
      this.samples.push({ at: wall, lag: lagFromMono });
      if (lagFromMono >= this.warnMs && wall - this.lastWarnAt >= this.warnIntervalMs) {
        this.lastWarnAt = wall;
        const maxLagMs = this.maxLag();
        this.warn(
          `[ws-metrics] event_loop_lag lag_ms=${lagFromMono} max_lag_ms=${maxLagMs} warn_ms=${this.warnMs}`
        );
      }
    }
    this.prune(wall);
    const tick = this.activeTickMs();
    this.expectedMono = mono + tick;
    this.arm();
  }

  private activeTickMs(): number {
    if (this.diagnostics || this.now() < this.fastUntil) return this.fastTickMs;
    return this.idleTickMs;
  }

  private arm(): void {
    const tick = this.activeTickMs();
    this.scheduledTickMs = tick;
    this.timer = this.schedule(() => this.tick(), tick);
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
  if (!shared) shared = new EventLoopLagSampler();
  return shared;
}

export function startGatewayEventLoopLag(): void {
  gatewayEventLoopLag().start();
}

export function stopGatewayEventLoopLag(): void {
  shared?.stop();
  shared = null;
}

export function demandGatewayEventLoopLagFast(holdMs?: number): void {
  shared?.demandFast(holdMs);
}

export function setGatewayEventLoopLagForTest(sampler: EventLoopLagSampler | null): void {
  shared?.stop();
  shared = sampler;
}

export function stopGatewayEventLoopLagForTest(): void {
  stopGatewayEventLoopLag();
}
