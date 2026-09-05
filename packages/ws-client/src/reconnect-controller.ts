// 重连退避：指数退避 + ±50% 抖动，定时器与计数集中在此。
// 缺省不设尝试次数上限：弱网下客户端应一直以封顶间隔重试，只有协议级 fatal、
// 会话失效（4401）或宿主显式关闭才停。

export interface ReconnectControllerOptions {
  /** 首次退避基数；第 n 次退避为 delayMs * 2^(n-1) 再乘抖动 */
  delayMs: number;
  /** 尝试次数上限，缺省无上限 */
  maxAttempts?: number;
  /** 退避上限，缺省 30s */
  maxDelayMs?: number;
  onReconnect: () => void;
  onSchedule?: (info: { attempt: number; delayMs: number }) => void;
  /** 抖动随机源（仅测试注入），缺省 Math.random */
  random?: () => number;
}

const DEFAULT_MAX_DELAY_MS = 30000;

/** 指数退避 + [0.5, 1) 抖动；`attempt` 从 1 起算。 */
export function reconnectDelayMs(
  attempt: number,
  minMs: number,
  maxMs: number,
  random: () => number = Math.random
): number {
  const exp = Math.min(maxMs, minMs * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.5 + random() * 0.5;
  return Math.min(maxMs, Math.floor(exp * jitter));
}

export class ReconnectController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;

  constructor(private readonly options: ReconnectControllerOptions) {}

  getAttempts(): number {
    return this.attempts;
  }

  canRetry(): boolean {
    return this.attempts < (this.options.maxAttempts ?? Number.POSITIVE_INFINITY);
  }

  isPending(): boolean {
    return this.timer !== null;
  }

  /** 已有在途重连时返回 false，不叠加定时器。 */
  schedule(): boolean {
    if (this.timer) return false;

    this.attempts += 1;
    const delayMs = reconnectDelayMs(
      this.attempts,
      this.options.delayMs,
      this.options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      this.options.random
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
