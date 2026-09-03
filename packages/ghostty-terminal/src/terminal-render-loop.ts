// rAF 渲染循环：合并同一帧内的多次渲染请求，并维护「下一次渲染必须全画」的一次性标记
// （canvas 被 resize 清空但内核仍报 dirty='clean' 时用，见 issue #45 bug 3）。
export class TerminalRenderLoop {
  private frame: number | null = null;
  private forceFullNext = false;
  private renderSuspended = false;

  constructor(private readonly paint: () => void) {}

  schedule(): void {
    if (this.renderSuspended || this.frame !== null) {
      return;
    }

    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.paint();
    });
  }

  setRenderSuspended(suspended: boolean): boolean {
    if (this.renderSuspended === suspended) {
      return false;
    }

    this.renderSuspended = suspended;
    if (suspended) {
      this.cancelPending();
    }
    return true;
  }

  // 标记下一次渲染全画，并取消排队中的帧交由调用方同步渲染。
  requestFullRepaint(): void {
    this.forceFullNext = true;
    this.cancelPending();
  }

  // 一次性消费：读后立即清零避免污染后续帧。渲染在早退检查之后才调用它，
  // 早退的那次不消费标记，留给下一次真正的渲染。
  consumeForceFull(): boolean {
    const forceFull = this.forceFullNext;
    this.forceFullNext = false;
    return forceFull;
  }

  cancelPending(): void {
    if (this.frame === null) {
      return;
    }

    cancelAnimationFrame(this.frame);
    this.frame = null;
  }
}

// 带尾部保证的节流任务：首次请求按距上次执行的剩余间隔延迟，期间的重复请求被合并，
// 终态仍会执行一次。
export class ThrottledTask {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRunAt = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly run: () => void
  ) {}

  schedule(): void {
    if (this.timer !== null) {
      return;
    }

    const delay = Math.max(0, this.intervalMs - (Date.now() - this.lastRunAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastRunAt = Date.now();
      this.run();
    }, delay);
  }

  cancel(): void {
    if (this.timer === null) {
      return;
    }

    clearTimeout(this.timer);
    this.timer = null;
  }
}
