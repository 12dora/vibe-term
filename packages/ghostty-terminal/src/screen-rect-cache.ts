// .xterm-screen 的 rect 缓存。
//
// getBoundingClientRect 是强制同步布局，而一次滚轮通知要为每一行编码一次鼠标上报，
// 每次都要 rect；它与同一帧里滚动条 / canvas 的样式写交错，构成典型的读写抖动。
// rect 只随布局变化，故缓存到下一次失效（容器尺寸变化、内容表面尺寸变化、平移滚动、
// 字体重量、重新挂载）为止；TTL 是兜底——祖先元素滚动之类的位移不经过本层任何观察点，
// 一帧的陈旧上限不可感知且会自愈。

export type TerminalScreenRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export const SCREEN_RECT_TTL_MS = 16;

// 会挪动 .xterm-screen 却不改变 .xterm-viewport 内容盒尺寸的信号：ResizeObserver 看不到
// 它们。scroll 用 capture 挂在 window 上，任意祖先容器的滚动都能收到（scroll 不冒泡，
// 但捕获阶段必经 window）；visualViewport 是手机虚拟键盘唯一的信号源。
const GLOBAL_LAYOUT_EVENTS = ['resize', 'scroll'] as const;

type LayoutEventTarget = {
  addEventListener(type: string, listener: () => void, options?: unknown): void;
  removeEventListener(type: string, listener: () => void, options?: unknown): void;
};

function globalLayoutTargets(): LayoutEventTarget[] {
  const view = typeof window === 'undefined' ? null : window;
  const candidates = [view, view?.visualViewport ?? null] as Array<LayoutEventTarget | null>;
  return candidates.filter(
    (target): target is LayoutEventTarget => typeof target?.addEventListener === 'function'
  );
}

function defaultNow(): number {
  return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

export class ScreenRectCache {
  private rect: TerminalScreenRect | null = null;
  private measuredAt = 0;
  private detachers: Array<() => void> = [];
  private readonly onGlobalLayoutChange = (): void => {
    this.rect = null;
  };

  constructor(
    private readonly ttlMs: number = SCREEN_RECT_TTL_MS,
    private readonly now: () => number = defaultNow
  ) {}

  read(element: HTMLElement | null): TerminalScreenRect | null {
    if (!element) {
      this.rect = null;
      return null;
    }

    const at = this.now();
    if (this.rect !== null && at - this.measuredAt < this.ttlMs) {
      return this.rect;
    }

    const measured = element.getBoundingClientRect();
    this.rect = {
      left: measured.left,
      top: measured.top,
      right: measured.right,
      bottom: measured.bottom,
      width: measured.width,
      height: measured.height,
    };
    this.measuredAt = at;
    return this.rect;
  }

  invalidate(): void {
    this.rect = null;
  }

  observeGlobalLayout(): void {
    this.releaseGlobalLayout();
    for (const target of globalLayoutTargets()) {
      for (const type of GLOBAL_LAYOUT_EVENTS) {
        target.addEventListener(type, this.onGlobalLayoutChange, { passive: true, capture: true });
        this.detachers.push(() => {
          target.removeEventListener(type, this.onGlobalLayoutChange, true);
        });
      }
    }
  }

  releaseGlobalLayout(): void {
    this.rect = null;
    for (const detach of this.detachers) {
      detach();
    }
    this.detachers = [];
  }
}
