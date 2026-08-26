// 重连退避：指数退避 + 尝试次数上限，定时器与计数集中在此。

export interface ReconnectControllerOptions {
  /** 首次退避基数；第 n 次退避为 delayMs * 2^(n-1) */
  delayMs: number;
  maxAttempts: number;
  /** 退避上限，缺省 30s */
  maxDelayMs?: number;
  onReconnect: () => void;
  onSchedule?: (info: { attempt: number; delayMs: number }) => void;
}

const DEFAULT_MAX_DELAY_MS = 30000;

export class ReconnectController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;

  constructor(private readonly options: ReconnectControllerOptions) {}

  getAttempts(): number {
    return this.attempts;
  }

  canRetry(): boolean {
    return this.attempts < this.options.maxAttempts;
  }

  isPending(): boolean {
    return this.timer !== null;
  }

  /** 已有在途重连时返回 false，不叠加定时器。 */
  schedule(): boolean {
    if (this.timer) return false;

    this.attempts += 1;
    const delayMs = Math.min(
      this.options.delayMs * 2 ** (this.attempts - 1),
      this.options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
    );
    this.options.onSchedule?.({ attempt: this.attempts, delayMs });

    this.timer = setTimeout(() => {
      this.timer = null;
      this.options.onReconnect();
    }, delayMs);
    return true;
  }

  /** 取消在途重连，保留已累计的尝试次数。 */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 取消在途重连并清零尝试次数。 */
  reset(): void {
    this.cancel();
    this.attempts = 0;
  }
}
