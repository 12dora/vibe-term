export interface ResizeSchedulerTimers {
  setTimeout: (handler: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  requestAnimationFrame: (handler: () => void) => number;
  cancelAnimationFrame: (id: number) => void;
}

export const RESIZE_DEBOUNCE_MS = 150;
export const POST_SELECT_RETRY_MS = 60;

export const browserResizeSchedulerTimers: ResizeSchedulerTimers = {
  setTimeout: (handler, ms) => window.setTimeout(handler, ms),
  clearTimeout: (id) => {
    window.clearTimeout(id);
  },
  requestAnimationFrame: (handler) => requestAnimationFrame(handler),
  cancelAnimationFrame: (id) => {
    cancelAnimationFrame(id);
  },
};

export function readDocumentFontsReady(): Promise<unknown> | null {
  if (typeof document === 'undefined' || !('fonts' in document)) {
    return null;
  }
  return document.fonts?.ready ?? null;
}

/** 单帧内合并重复请求：后到的请求取消前一帧回调 */
export class RafCoalescer {
  private frameId: number | null = null;
  private readonly timers: Pick<
    ResizeSchedulerTimers,
    'requestAnimationFrame' | 'cancelAnimationFrame'
  >;

  constructor(
    timers: Pick<ResizeSchedulerTimers, 'requestAnimationFrame' | 'cancelAnimationFrame'>
  ) {
    this.timers = timers;
  }

  request(run: () => void): void {
    this.cancel();
    this.frameId = this.timers.requestAnimationFrame(() => {
      this.frameId = null;
      run();
    });
  }

  cancel(): void {
    if (this.frameId === null) {
      return;
    }
    this.timers.cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }
}

export interface ResizeSchedulerOptions {
  debounceMs?: number;
  postSelectRetryMs?: number;
}

/**
 * 尺寸上报的时序编排：防抖合并 + 落在 RAF 上执行（等布局稳定），
 * 以及 pane 切换后的“立即 / 短延时 / 字体就绪”三轮补测。
 * dispose 只取消在途回调、不做永久失效，StrictMode 双挂载复用同一实例仍可继续调度。
 */
export class TerminalResizeScheduler {
  private timerId: number | null = null;
  private postSelectTimers: number[] = [];
  private readonly frame: RafCoalescer;
  private readonly timers: ResizeSchedulerTimers;
  private readonly debounceMs: number;
  private readonly postSelectRetryMs: number;

  constructor(timers: ResizeSchedulerTimers, options: ResizeSchedulerOptions = {}) {
    this.timers = timers;
    this.frame = new RafCoalescer(timers);
    this.debounceMs = options.debounceMs ?? RESIZE_DEBOUNCE_MS;
    this.postSelectRetryMs = options.postSelectRetryMs ?? POST_SELECT_RETRY_MS;
  }

  schedule(run: () => void, options: { immediate?: boolean } = {}): void {
    this.cancelPending();
    if (options.immediate) {
      this.frame.request(run);
      return;
    }
    this.timerId = this.timers.setTimeout(() => {
      this.timerId = null;
      this.frame.request(run);
    }, this.debounceMs);
  }

  runPostSelect(trigger: () => void, getFontsReady: () => Promise<unknown> | null): void {
    this.clearPostSelectTimers();
    trigger();

    this.postSelectTimers.push(this.timers.setTimeout(trigger, this.postSelectRetryMs));

    const fontsReady = getFontsReady();
    if (!fontsReady) {
      return;
    }
    fontsReady
      .then(() => {
        trigger();
      })
      .catch(() => {});
  }

  clearPostSelectTimers(): void {
    for (const id of this.postSelectTimers) {
      this.timers.clearTimeout(id);
    }
    this.postSelectTimers = [];
  }

  dispose(): void {
    this.clearPostSelectTimers();
    this.cancelPending();
  }

  private cancelPending(): void {
    if (this.timerId !== null) {
      this.timers.clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.frame.cancel();
  }
}
