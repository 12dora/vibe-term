// blitRows 的 ping-pong 中转画布池。每个 CanvasRenderer 各持一个池：中转画布是全尺寸
// 位图（iPhone DPR3 下每张 ~10 MB），若整个模块共用一张，分屏里两个渲染器同一帧滚动时
// 会互相把它从对方的层栈里抢走 —— 每帧一次 insertBefore 跨父节点搬迁，尺寸不同还要重设
// canvas.width/height（HTML5 标准的整张位图重分配）。按渲染器分池后，稳态下每次 blit
// 只做 drawImage 与两张画布的属性互换。
//
// 代价是「一张额外位图 / 活跃渲染器」。为了不让保活但不可见的面板长期占着位图，池在
// 空闲 SCRATCH_IDLE_RELEASE_MS 后自行释放，下次 blit 再懒分配。

export type ScratchSurface = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
};

export function ensureCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('2d canvas context unavailable');
  }

  return context;
}

// 面板被隐藏时渲染整体挂起（Terminal.setRenderSuspended），渲染器本身仍保活，因此
// 「距上次 blit 的时长」就是「当前不可见 / 不在滚动」的可用代理信号：渲染器不需要
// 额外的可见性回调，超时即释放中转位图。
export const SCRATCH_IDLE_RELEASE_MS = 5_000;

type IdleTimer = ReturnType<typeof setTimeout> & { unref?: () => void };

export class ScratchSurfacePool {
  private surface: ScratchSurface | null = null;
  private idleTimer: IdleTimer | null = null;
  private lastUsedAt = 0;
  private readonly idleReleaseMs: number;

  constructor(idleReleaseMs: number = SCRATCH_IDLE_RELEASE_MS) {
    this.idleReleaseMs = idleReleaseMs;
  }

  /** 当前停放的中转画布；未分配或已因空闲释放时为 null。 */
  get parked(): ScratchSurface | null {
    return this.surface;
  }

  // owner 是调用方主画布所属的 document：跨 document 的位图不能共用。
  acquire(owner: Document): ScratchSurface {
    const existing = this.surface;
    if (existing && existing.canvas.ownerDocument === owner) {
      this.noteUse();
      return existing;
    }

    this.dropSurface();
    const canvas = document.createElement('canvas');
    canvas.dataset.layer = 'scratch';
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.opacity = '0';
    const surface: ScratchSurface = { canvas, context: ensureCanvasContext(canvas) };
    this.surface = surface;
    this.noteUse();
    return surface;
  }

  // ping-pong 的另一半：调用方把 acquire 拿到的画布升为主画布后，让位的旧主画布接替
  // 停放。池里始终至多一张位图，所以这里直接顶替（被顶替的那张此刻正是新的主画布）。
  park(surface: ScratchSurface): void {
    this.surface = surface;
    this.noteUse();
  }

  release(): void {
    this.cancelIdleTimer();
    this.dropSurface();
  }

  private noteUse(): void {
    this.lastUsedAt = Date.now();
    if (this.idleTimer === null) {
      this.armIdleTimer(this.idleReleaseMs);
    }
  }

  // 只在没有计时器时武装一次，到点再按真实空闲时长决定释放还是续期：避免每帧 blit
  // 都做一次 clearTimeout + setTimeout。
  private armIdleTimer(delay: number): void {
    const timer = setTimeout(() => {
      this.idleTimer = null;
      const idleFor = Date.now() - this.lastUsedAt;
      if (idleFor >= this.idleReleaseMs) {
        this.dropSurface();
        return;
      }

      this.armIdleTimer(this.idleReleaseMs - idleFor);
    }, delay) as IdleTimer;
    // Bun / Node 下不让空闲计时器吊住事件循环；浏览器返回数字，无此方法。
    timer.unref?.();
    this.idleTimer = timer;
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private dropSurface(): void {
    if (this.surface) {
      this.surface.canvas.remove();
      this.surface.canvas.width = 0;
      this.surface.canvas.height = 0;
    }

    this.surface = null;
  }
}
