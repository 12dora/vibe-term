// 键盘避让要读的两处 DOM，各自带上缓存：follow 模式逐帧调用，元素查询与尺寸读取都不该
// 每帧重来。元素被换掉（React 重挂）时按 isConnected 重新解析。

/** 读某个元素当前实际应用的 translateY 位移（px，正数表示上移）。 */
export class AppliedTransformReader {
  private element: Element | null = null;

  constructor(private readonly selector: string) {}

  read(): number {
    if (!this.element || !this.element.isConnected) {
      this.element = document.querySelector(this.selector);
    }
    if (!this.element) {
      return 0;
    }
    const transform = window.getComputedStyle(this.element).transform;
    if (!transform || transform === 'none') {
      return 0;
    }
    try {
      return -new DOMMatrix(transform).m42; // 我们应用 translateY(-offset)，m42 = -offset
    } catch {
      return 0;
    }
  }
}

/** 快捷键栏：元素引用带缓存，高度由 ResizeObserver 推送，避免每帧 offsetHeight 强制布局。 */
export class ShortcutStripTracker {
  private element: HTMLElement | null = null;
  private observed: HTMLElement | null = null;
  private readonly observer: ResizeObserver | null;
  private height = 0;

  constructor(
    private readonly selector: string,
    onResize: () => void
  ) {
    this.observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            for (const entry of entries) {
              const next = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
              if (next === this.height) {
                continue;
              }
              this.height = next;
              onResize();
            }
          });
  }

  resolve(): HTMLElement | null {
    if (!this.element || !this.element.isConnected) {
      this.attach(document.querySelector<HTMLElement>(this.selector));
    }
    return this.element;
  }

  /** 没有 ResizeObserver 的环境回落到即时读取，语义不变。 */
  heightOf(element: HTMLElement | null): number {
    if (!element) {
      return 0;
    }
    return this.observer ? this.height : element.offsetHeight;
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.element = null;
    this.observed = null;
  }

  private attach(element: HTMLElement | null): void {
    this.element = element;
    if (this.observed === element) {
      return;
    }
    if (this.observed && this.observer) {
      this.observer.unobserve(this.observed);
    }
    this.observed = element;
    // ResizeObserver 的首拍要等一帧，先同步种一次高度，避免这一帧按 0 算
    this.height = element ? element.offsetHeight : 0;
    if (element && this.observer) {
      this.observer.observe(element);
    }
  }
}
