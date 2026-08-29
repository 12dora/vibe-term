// 同步输出（DECSET 2026）激活期间挂起渲染的兜底时限：应用悬挂或关闭帧迟迟不到时，
// 最迟此间隔后仍强制渲染一次，与主流终端对 2026 的安全阀行为一致。
const SYNCHRONIZED_OUTPUT_FALLBACK_MS = 150;

// 只在同步输出激活期间存活的单次定时器。arm 可重复调用（已武装则维持原时限），
// cancel 必须在控制器 dispose 时调用，否则挂起的 timer 会拖住测试进程。
export class SynchronizedOutputFallback {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onExpire: () => void) {}

  arm(): void {
    if (this.timer !== null) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.onExpire();
    }, SYNCHRONIZED_OUTPUT_FALLBACK_MS);
  }

  cancel(): void {
    if (this.timer === null) {
      return;
    }

    clearTimeout(this.timer);
    this.timer = null;
  }
}
