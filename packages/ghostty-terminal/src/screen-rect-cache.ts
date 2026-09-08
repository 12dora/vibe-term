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

function defaultNow(): number {
  return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

export class ScreenRectCache {
  private rect: TerminalScreenRect | null = null;
  private measuredAt = 0;

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
}
