// 浏览器剪贴板写入：Clipboard API 优先，被拒/不可用时回退 textarea + execCommand('copy')。
// 纯浏览器侧模块（无 node 依赖），非浏览器环境下调用会抛 'clipboard unavailable'。

export async function writeTextToClipboard(text: string): Promise<void> {
  if (!text) {
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to execCommand fallback
    }
  }

  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    throw new Error('clipboard unavailable');
  }

  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', 'true');
  helper.style.position = 'fixed';
  helper.style.left = '-9999px';
  helper.style.top = '0';
  document.body.appendChild(helper);
  try {
    helper.select();
    if (!document.execCommand('copy')) {
      throw new Error('execCommand copy failed');
    }
  } finally {
    helper.remove();
  }
}

// ==================== 延迟剪贴板写入 ====================

// 远端发起的复制（如 tmux OSC52）到达时没有用户激活，iOS Safari 会直接拒掉
// navigator.clipboard.writeText（execCommand 回退同样受限）。此时把文本挂起，
// 等下一次真实用户手势（capture 阶段的 pointerdown/touchend/keydown）里同步重试。
export const DEFERRED_CLIPBOARD_TTL_MS = 20_000;

const GESTURE_EVENT_TYPES = ['pointerdown', 'touchend', 'keydown'] as const;

export interface DeferredClipboardHandlers {
  /** 首次挂起：提示用户点一下屏幕完成复制 */
  onPending(): void;
  onSuccess(): void;
  onFailure(error: unknown): void;
}

export interface GestureEventTarget {
  addEventListener(type: string, listener: () => void, options?: { capture?: boolean }): void;
  removeEventListener(type: string, listener: () => void, options?: { capture?: boolean }): void;
}

export interface DeferredClipboardOptions {
  write?: (text: string) => Promise<void>;
  ttlMs?: number;
  target?: GestureEventTarget | null;
}

export interface DeferredClipboardWriter {
  write(text: string): Promise<void>;
  hasPending(): boolean;
  dispose(): void;
}

const GESTURE_LISTENER_OPTIONS = { capture: true } as const;

class DeferredClipboardWriterImpl implements DeferredClipboardWriter {
  private pendingText: string | null = null;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private listeningTarget: GestureEventTarget | null = null;
  // 逻辑写入代次：并发写入可能乱序完成，只有最新一代的完成结果才允许改挂起状态、发通知，
  // 否则旧写入的失败会盖掉更新的挂起文本，旧写入的成功会把更新的挂起文本清掉。
  private generation = 0;
  // 挂起文本所属代次：手势重试属于同一次逻辑写入，沿用它而不是另开新代
  private pendingGeneration = 0;
  private disposed = false;

  private readonly writeText: (text: string) => Promise<void>;
  private readonly ttlMs: number;

  constructor(
    private readonly handlers: DeferredClipboardHandlers,
    private readonly options: DeferredClipboardOptions = {}
  ) {
    this.writeText = options.write ?? writeTextToClipboard;
    this.ttlMs = options.ttlMs ?? DEFERRED_CLIPBOARD_TTL_MS;
  }

  hasPending(): boolean {
    return this.pendingText !== null;
  }

  async write(text: string): Promise<void> {
    if (this.disposed) return;
    const generation = this.nextGeneration();
    try {
      await this.writeText(text);
    } catch {
      if (this.isStale(generation)) return;
      this.defer(text, generation);
      return;
    }
    if (this.isStale(generation)) return;
    // 立即写成功：此前挂起的文本已过时，静默丢弃
    this.clearPending();
    this.handlers.onSuccess();
  }

  dispose(): void {
    this.disposed = true;
    this.clearPending();
  }

  private nextGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  /** dispose 之后、或已被更新的逻辑写入取代的完成结果一律不再处理 */
  private isStale(generation: number): boolean {
    return this.disposed || generation !== this.generation;
  }

  private resolveTarget(): GestureEventTarget | null {
    if (this.options.target !== undefined) return this.options.target;
    return typeof window === 'undefined' ? null : (window as unknown as GestureEventTarget);
  }

  private defer(text: string, generation: number): void {
    const target = this.resolveTarget();
    if (!target) {
      this.handlers.onFailure(new Error('clipboard write requires a user gesture'));
      return;
    }

    const wasPending = this.pendingText !== null;
    this.pendingText = text;
    this.pendingGeneration = generation;
    this.armTtl();
    if (wasPending) return;

    this.listeningTarget = target;
    for (const type of GESTURE_EVENT_TYPES) {
      target.addEventListener(type, this.onGesture, GESTURE_LISTENER_OPTIONS);
    }
    this.handlers.onPending();
  }

  private armTtl(): void {
    if (this.ttlTimer !== null) clearTimeout(this.ttlTimer);
    this.ttlTimer = setTimeout(this.onExpire, this.ttlMs);
  }

  private clearPending(): void {
    this.pendingText = null;
    if (this.ttlTimer !== null) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
    const target = this.listeningTarget;
    if (!target) return;
    this.listeningTarget = null;
    for (const type of GESTURE_EVENT_TYPES) {
      target.removeEventListener(type, this.onGesture, GESTURE_LISTENER_OPTIONS);
    }
  }

  // 必须在手势回调里同步发起 writeText，否则激活窗口已关闭
  private readonly onGesture = (): void => {
    const text = this.pendingText;
    const generation = this.pendingGeneration;
    this.clearPending();
    if (text === null) return;
    void this.writeText(text).then(
      () => {
        if (!this.isStale(generation)) this.handlers.onSuccess();
      },
      (error) => {
        if (!this.isStale(generation)) this.handlers.onFailure(error);
      }
    );
  };

  private readonly onExpire = (): void => {
    if (this.pendingText === null) return;
    this.clearPending();
    this.handlers.onFailure(new Error('deferred clipboard write expired'));
  };
}

export function createDeferredClipboardWriter(
  handlers: DeferredClipboardHandlers,
  options: DeferredClipboardOptions = {}
): DeferredClipboardWriter {
  return new DeferredClipboardWriterImpl(handlers, options);
}
