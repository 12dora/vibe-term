import type { TmuxConnectionOptions } from './connection-types';
import type { ControlCommandLatencyOptions, ControlModeCommandQueue } from './control-mode-capture';
import type { InputLaneClock } from './pane-input-pacer';

/** 设备宿主一跳（网关 ↔ tmux）往返延迟。 */
export interface HostLatencySample {
  /** EWMA 平滑值（毫秒，非负整数）。 */
  rttMs: number;
  /** 最近一次原始样本（毫秒，非负整数）。 */
  rawMs: number;
  /** DEVICE_LATENCY_HOP_LOCAL / DEVICE_LATENCY_HOP_SSH。 */
  hop: number;
  /** 采样时刻（Unix ms）。 */
  sampledAt: number;
}

export type HostLatencyListener = (sample: HostLatencySample) => void;

/** 与 PaneInputPacer 的输出节拍估计同一档平滑系数。 */
export const HOST_LATENCY_EWMA_ALPHA = 0.25;
/** 无样本超过这么久且有会话在线时补一次探针。 */
export const HOST_LATENCY_IDLE_PROBE_MS = 15_000;
/** 超过控制命令最长超时的样本一律视为异常丢弃。 */
export const HOST_LATENCY_MAX_SAMPLE_MS = 30_000;
/** 探针超时取控制通道上限；配合 poisonOnTimeout:false，超时只丢这一条。 */
export const HOST_LATENCY_PROBE_TIMEOUT_MS = 30_000;
/** display-message -p 只写 stdout，不碰状态栏、不产生 %output、不改 pane 状态。 */
export const HOST_LATENCY_PROBE_COMMAND = 'display-message -p "vibeterm-lat"';

const systemClock: InputLaneClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export interface HostLatencyTrackerOptions {
  /** 补样探针；返回的 Promise 结算前不会再发第二条。返回 `'busy'` 视为队列仍有活动。 */
  probe?: () => Promise<unknown> | unknown;
  /** 队列忙时不要发探针，并把这次空闲时钟推后一个窗口。 */
  canProbe?: () => boolean;
  clock?: InputLaneClock;
  wallClock?: () => number;
  idleProbeIntervalMs?: number;
}

/**
 * 每设备一份：吃 write→%end 的原始样本，产出 EWMA 平滑值，并在空闲且有人在线时补探针。
 * 只做估计与调度，不关心谁在监听、样本从哪条连接来。
 */
export class HostLatencyTracker {
  private readonly clock: InputLaneClock;
  private readonly wallClock: () => number;
  private readonly idleProbeIntervalMs: number;
  private readonly listeners = new Set<HostLatencyListener>();

  private smoothed: number | null = null;
  private latest: HostLatencySample | null = null;
  private probeGate: (() => boolean) | null = null;
  private probeInFlight = false;
  private timer: unknown = null;
  private lastSampleAt: number;
  private lastProbeAt: number;
  private disposed = false;

  constructor(private readonly options: HostLatencyTrackerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.wallClock = options.wallClock ?? (() => Date.now());
    this.idleProbeIntervalMs = options.idleProbeIntervalMs ?? HOST_LATENCY_IDLE_PROBE_MS;
    this.lastSampleAt = this.clock.now();
    this.lastProbeAt = this.lastSampleAt;
  }

  current(): HostLatencySample | null {
    return this.latest;
  }

  subscribe(listener: HostLatencyListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** gate 为 null 时彻底停掉探针；否则每次发探针前再问一次是否仍有会话在线。 */
  setProbeGate(gate: (() => boolean) | null): void {
    this.probeGate = gate;
    if (!gate) {
      this.cancelTimer();
      return;
    }
    this.armTimer();
  }

  record(rawMs: number, hop: number): void {
    if (this.disposed || !isUsableSample(rawMs)) return;
    const raw = Math.max(0, Math.round(rawMs));
    this.smoothed =
      this.smoothed === null
        ? raw
        : this.smoothed + HOST_LATENCY_EWMA_ALPHA * (raw - this.smoothed);
    this.latest = {
      rttMs: Math.max(0, Math.round(this.smoothed)),
      rawMs: raw,
      hop,
      sampledAt: this.wallClock(),
    };
    this.lastSampleAt = this.clock.now();
    this.armTimer();
    const sample = this.latest;
    for (const listener of this.listeners) {
      try {
        listener(sample);
      } catch (error) {
        console.error('[tmux-client] host latency listener failed:', error);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.probeGate = null;
    this.cancelTimer();
    this.listeners.clear();
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private armTimer(): void {
    const idleSince = Math.max(this.lastSampleAt, this.lastProbeAt);
    this.scheduleIn(Math.max(0, this.idleProbeIntervalMs - (this.clock.now() - idleSince)));
  }

  private scheduleIn(delayMs: number): void {
    if (this.disposed || !this.probeGate || this.timer !== null) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.runProbe();
    }, delayMs);
  }

  private runProbe(): void {
    if (this.disposed) return;
    const gate = this.probeGate;
    if (!gate) return;
    const idleMs = this.clock.now() - this.lastSampleAt;
    // 还没空闲够就补足剩余时间；探针在途或没人在线则整窗后再问一次，避免空转。
    if (idleMs < this.idleProbeIntervalMs) {
      this.scheduleIn(this.idleProbeIntervalMs - idleMs);
      return;
    }
    if (this.probeInFlight || !gate()) {
      this.scheduleIn(this.idleProbeIntervalMs);
      return;
    }
    if (this.options.canProbe && !this.options.canProbe()) {
      this.lastSampleAt = this.clock.now();
      this.scheduleIn(this.idleProbeIntervalMs);
      return;
    }
    this.lastProbeAt = this.clock.now();
    this.probeInFlight = true;
    void Promise.resolve()
      .then(() => this.options.probe?.())
      .then((result) => {
        if (result === 'busy') this.lastSampleAt = this.clock.now();
      })
      .catch(() => undefined)
      .then(() => {
        this.probeInFlight = false;
        this.armTimer();
      });
  }
}

function isUsableSample(rawMs: number): boolean {
  return Number.isFinite(rawMs) && rawMs >= 0 && rawMs <= HOST_LATENCY_MAX_SAMPLE_MS;
}

/** 把连接回调包成控制队列的采样出口；上层没接采样时返回 undefined（队列不计时）。 */
export function hostLatencySampler(
  callbacks: TmuxConnectionOptions,
  hop: number
): ControlCommandLatencyOptions | undefined {
  const sink = callbacks.onHostLatencySample;
  return sink ? { onSample: (rttMs) => sink(rttMs, hop) } : undefined;
}

export type HostLatencyProbeResult = undefined | 'busy';

/** 通过与 send-keys 相同的控制命令路径发一条廉价探针，失败静默（连接层自有告警）。 */
export function probeHostLatency(
  queue: ControlModeCommandQueue,
  write: ((data: string) => void) | null
): Promise<HostLatencyProbeResult> {
  if (!write) return Promise.resolve(undefined);
  if (queue.busy) return Promise.resolve('busy');
  return queue
    .execute(write, HOST_LATENCY_PROBE_COMMAND, {
      sample: true,
      timeoutMs: HOST_LATENCY_PROBE_TIMEOUT_MS,
      poisonOnTimeout: false,
      transform: () => undefined,
    })
    .catch(() => undefined);
}
