// 重连退避：指数退避 + ±50% 抖动，定时器与计数集中在此。
// 缺省不设尝试次数上限：弱网下客户端应一直以封顶间隔重试，只有协议级 fatal、
// 会话失效（4401）或宿主显式关闭才停。
// 计数只在会话**保持健康**一段时间后清零（`armHealthyReset`）：握手一成功就清零的话，
// 每次 HELLO 后就被关掉的链路会以 0.5–1 s 的间隔永远重连。

export interface ReconnectControllerOptions {
  /** 首次退避基数；第 n 次退避为 delayMs * 2^(n-1) 再乘抖动 */
  delayMs: number;
  /** 尝试次数上限，缺省无上限 */
  maxAttempts?: number;
  /** 退避上限，缺省 30s */
  maxDelayMs?: number;
  onReconnect: () => void;
  onSchedule?: (info: { attempt: number; delayMs: number }) => void;
  /** 每次退避的下限（宿主按目标的不可达退避给出），不参与指数计数；缺省 0。 */
  minDelayMs?: () => number;
  /** 会话保持多久才清零计数；缺省 `DEFAULT_RECONNECT_HEALTHY_MS`。 */
  healthyMs?: number;
  /** 抖动随机源（仅测试注入），缺省 Math.random */
  random?: () => number;
}

const DEFAULT_MAX_DELAY_MS = 30000;
export const DEFAULT_RECONNECT_HEALTHY_MS = 12_000;

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
  private healthyTimer: ReturnType<typeof setTimeout> | null = null;
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
    const backoffMs = reconnectDelayMs(
      this.attempts,
      this.options.delayMs,
      this.options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      this.options.random
    );
    const delayMs = Math.max(backoffMs, this.options.minDelayMs?.() ?? 0);
    this.options.onSchedule?.({ attempt: this.attempts, delayMs });

    this.timer = setTimeout(() => {
      this.timer = null;
      this.options.onReconnect();
    }, delayMs);
    return true;
  }

  /** 会话保持 `healthyMs` 且 `stillHealthy()` 仍为真：清零计数并回调。重复调用以最后一次为准。 */
  armHealthyReset(stillHealthy: () => boolean, onHealthy: () => void): void {
    this.clearHealthyReset();
    this.healthyTimer = setTimeout(() => {
      this.healthyTimer = null;
      if (!stillHealthy()) return;
      this.attempts = 0;
      onHealthy();
    }, this.options.healthyMs ?? DEFAULT_RECONNECT_HEALTHY_MS);
  }

  clearHealthyReset(): void {
    if (!this.healthyTimer) return;
    clearTimeout(this.healthyTimer);
    this.healthyTimer = null;
  }

  /** 取消在途重连与健康计时，保留已累计的尝试次数。 */
  cancel(): void {
    this.clearHealthyReset();
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
