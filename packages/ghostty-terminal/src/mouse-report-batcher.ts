// 滚轮鼠标上报的合并窗口。
//
// 一次滚轮通知（Chrome 的一格 ≈ 5–6 行）原本按行调用 emitData，每行一个 WebSocket
// 帧；触摸惯性帧以 120Hz 再入同一条路径。上报字节最终要逐条写进远端 pty，帧数越多
// 排队越深，画面就越跟不上手指。
//
// 这里做两级合并：调用方先把一次手势的 N 条序列拼成一条 push 进来；连续的滚轮手势
// 再落进一个尾随窗口——首条立即发（不给单次滚动引入延迟），窗口内后到的累积，窗口
// 关闭时一次发出。字节内容不变、顺序不变，网关侧按序列拆分后仍按 pane 节奏逐条落盘。

/**
 * 跨手势的尾随合批窗口。默认 0：一次手势的多行仍合成一条，但不再把后续手势压到 16 ms 后才发——
 * 实测那一拍延迟在快速滚动时能被感知（2.0.4/2.0.5 反馈「慢一拍」）。
 */
export const MOUSE_REPORT_COALESCE_MS = 0;

export type MouseReportBatcherOptions = {
  emit: (payload: string) => void;
  windowMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

function defaultNow(): number {
  return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

export class MouseReportBatcher {
  private readonly emit: (payload: string) => void;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private readonly pending: string[] = [];
  private timer: unknown = null;
  private lastEmitAt = Number.NEGATIVE_INFINITY;

  constructor(options: MouseReportBatcherOptions) {
    this.emit = options.emit;
    this.windowMs = options.windowMs ?? MOUSE_REPORT_COALESCE_MS;
    this.now = options.now ?? defaultNow;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  push(payload: string): void {
    if (payload === '') {
      return;
    }

    this.pending.push(payload);
    if (this.timer !== null) {
      return;
    }

    const elapsed = this.now() - this.lastEmitAt;
    if (elapsed >= this.windowMs) {
      this.flush();
      return;
    }

    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, this.windowMs - elapsed);
  }

  // 同步发出挂起的字节。任何其他输入（按键、粘贴、非滚轮鼠标事件）发送前都要先调用，
  // 否则窗口里的滚动会排到后面，顺序与用户操作相反。
  flush(): void {
    this.cancelTimer();
    if (this.pending.length === 0) {
      return;
    }

    const payload = this.pending.join('');
    this.pending.length = 0;
    this.lastEmitAt = this.now();
    this.emit(payload);
  }

  // 丢弃挂起的字节：pane 已退出上报模式 / 已禁用输入 / 已销毁时，这些字节送过去
  // 会被应用当成普通输入解释。
  discard(): void {
    this.cancelTimer();
    this.pending.length = 0;
  }

  private cancelTimer(): void {
    if (this.timer === null) {
      return;
    }

    this.clearTimer(this.timer);
    this.timer = null;
  }
}
