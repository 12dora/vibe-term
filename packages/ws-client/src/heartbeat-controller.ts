// 心跳：按间隔发 PING，并为每次已发出的 PING 武装 PONG 超时。
// 不感知协议编码，发帧与超时处置由宿主注入。
// 同时只允许一个在途探测：nonce 关联 RTT，未完成时跳过间隔 tick。

export interface HeartbeatControllerOptions {
  intervalMs: number;
  pongTimeoutMs: number;
  /** 发送一帧 PING；返回 false 表示当前不可发送，此时不武装 PONG 超时。 */
  sendPing: (nonce: number) => boolean;
  /** PONG 超时未回；宿主通常据此关闭连接触发重连。 */
  onPongTimeout: () => void;
  /** 单调时钟；缺省 `performance.now()`，不可用时回退 `Date.now()`。 */
  now?: () => number;
}

export interface HeartbeatCadence {
  intervalMs: number;
  pongTimeoutMs: number;
}

export interface HeartbeatLatencySample {
  rawMs: number;
  latencyMs: number;
}

const SAMPLE_WINDOW = 5;

function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function randomNonce(): number {
  return (Math.random() * 0x1_0000_0000) >>> 0;
}

function medianRounded(samples: readonly number[]): number {
  const sorted = samples.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

export class HeartbeatController {
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPingSentAt = 0;
  private pendingNonce: number | null = null;
  private readonly samples: number[] = [];
  private intervalMs: number;
  private pongTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: HeartbeatControllerOptions) {
    this.intervalMs = options.intervalMs;
    this.pongTimeoutMs = options.pongTimeoutMs;
    this.now = options.now ?? defaultNow;
  }

  get cadence(): HeartbeatCadence {
    return { intervalMs: this.intervalMs, pongTimeoutMs: this.pongTimeoutMs };
  }

  /**
   * 运行时改节奏（如页面转入后台放慢心跳）。只重排间隔定时器，不补发 PING；
   * 在途 PONG 超时保持原有截止时间，新的 pongTimeoutMs 从下一次 PING 起生效。
   */
  setCadence(intervalMs: number, pongTimeoutMs: number): void {
    if (this.intervalMs === intervalMs && this.pongTimeoutMs === pongTimeoutMs) return;
    this.intervalMs = intervalMs;
    this.pongTimeoutMs = pongTimeoutMs;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = setInterval(() => this.ping(), this.intervalMs);
    }
  }

  start(): void {
    this.stop();
    this.intervalTimer = setInterval(() => this.ping(), this.intervalMs);
  }

  /** 停止心跳，并解除尚未落地的 PONG 超时，避免跨连接误关新 socket。 */
  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.clearPendingProbe();
    this.samples.length = 0;
  }

  isRunning(): boolean {
    return this.intervalTimer !== null;
  }

  /**
   * 发出一次探测。已有在途 PONG 时跳过（返回 null），由 pong-timeout 继续守活。
   * 成功发出时返回本次 nonce。
   */
  ping(): number | null {
    if (this.hasPendingPong()) return null;
    const nonce = randomNonce();
    if (!this.options.sendPing(nonce)) return null;
    this.pendingNonce = nonce;
    this.lastPingSentAt = this.now();
    this.clearPongTimeout();
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      this.pendingNonce = null;
      this.lastPingSentAt = 0;
      this.options.onPongTimeout();
    }, this.pongTimeoutMs);
    return nonce;
  }

  /**
   * 收到 PONG：仅匹配在途 nonce 时解除超时并返回 RTT。
   * 错配 / 迟到的 PONG 不清理在途探测、不算延迟；调用方仍可将其视为连接存活。
   */
  notePong(nonce: number): HeartbeatLatencySample | null {
    if (this.pendingNonce === null || nonce !== this.pendingNonce) return null;
    this.clearPongTimeout();
    const sentAt = this.lastPingSentAt;
    this.pendingNonce = null;
    this.lastPingSentAt = 0;
    if (sentAt <= 0) return null;
    const rawMs = Math.max(0, Math.round(this.now() - sentAt));
    this.samples.push(rawMs);
    if (this.samples.length > SAMPLE_WINDOW) this.samples.shift();
    return { rawMs, latencyMs: medianRounded(this.samples) };
  }

  clearPongTimeout(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  hasPendingPong(): boolean {
    return this.pongTimer !== null;
  }

  private clearPendingProbe(): void {
    this.clearPongTimeout();
    this.pendingNonce = null;
    this.lastPingSentAt = 0;
  }
}
