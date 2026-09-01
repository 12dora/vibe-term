// 心跳：按间隔发 PING，并为每次已发出的 PING 武装 PONG 超时。
// 不感知协议编码，发帧与超时处置由宿主注入。

export interface HeartbeatControllerOptions {
  intervalMs: number;
  pongTimeoutMs: number;
  /** 发送一帧 PING；返回 false 表示当前不可发送，此时不武装 PONG 超时。 */
  sendPing: () => boolean;
  /** PONG 超时未回；宿主通常据此关闭连接触发重连。 */
  onPongTimeout: () => void;
}

export interface HeartbeatCadence {
  intervalMs: number;
  pongTimeoutMs: number;
}

export class HeartbeatController {
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPingSentAt = 0;
  private intervalMs: number;
  private pongTimeoutMs: number;

  constructor(private readonly options: HeartbeatControllerOptions) {
    this.intervalMs = options.intervalMs;
    this.pongTimeoutMs = options.pongTimeoutMs;
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
    this.clearPongTimeout();
    this.lastPingSentAt = 0;
  }

  isRunning(): boolean {
    return this.intervalTimer !== null;
  }

  ping(): void {
    if (!this.options.sendPing()) return;
    this.lastPingSentAt = Date.now();
    this.clearPongTimeout();
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      this.options.onPongTimeout();
    }, this.pongTimeoutMs);
  }

  /** 收到 PONG：解除超时并返回 RTT（无在途 PING 时返回 null）。 */
  notePong(): number | null {
    this.clearPongTimeout();
    if (this.lastPingSentAt <= 0) return null;
    return Date.now() - this.lastPingSentAt;
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
}
