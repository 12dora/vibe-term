// 同步输出（DECSET 2026）挂起渲染的兜底时限：应用悬挂或关闭帧迟迟不到时最迟此间隔后强制渲染一次，与主流终端一致。
const SYNCHRONIZED_OUTPUT_FALLBACK_MS = 150;

export class SynchronizedOutputFallback {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly fire: () => void) {}

  arm(): void {
    if (this.timer !== null) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.fire();
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
