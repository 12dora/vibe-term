// 网络恢复唤醒：`online` 与 `navigator.connection` 的 `change` 两个事件源。
// 退避已经排到封顶间隔时干等一个整间隔纯属浪费，网络一回来就立刻醒一次。
// 非浏览器宿主（bun / node）两个事件源都取不到，install 后就是空操作。

/** 事件源的最小结构子集（`window` / `navigator.connection` 都满足）。 */
interface EventTargetLike {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}

/** `navigator.connection` 的 `change` 抖动很密，去抖后再唤醒（与直连载体同一节奏）。 */
export const NETWORK_CHANGE_DEBOUNCE_MS = 800;

function windowEventSource(): EventTargetLike | null {
  const target = (globalThis as { window?: Partial<EventTargetLike> }).window;
  if (!target || typeof target.addEventListener !== 'function') return null;
  return target as EventTargetLike;
}

function connectionEventSource(): EventTargetLike | null {
  const nav = (globalThis as { navigator?: { connection?: unknown } }).navigator;
  const conn = nav?.connection as Partial<EventTargetLike> | undefined;
  if (!conn || typeof conn.addEventListener !== 'function') return null;
  return conn as EventTargetLike;
}

export class NetworkWakeListeners {
  private readonly cleanups: Array<() => void> = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onWake: () => void) {}

  /** 幂等：已装过就不重复装。 */
  install(): void {
    if (this.cleanups.length > 0) return;
    this.bind(windowEventSource(), 'online', 0);
    // Wi-Fi ↔ 蜂窝切换通常不触发 `online`，只有 Network Information API 的 change。
    this.bind(connectionEventSource(), 'change', NETWORK_CHANGE_DEBOUNCE_MS);
  }

  dispose(): void {
    this.clearTimer();
    for (const off of this.cleanups.splice(0)) {
      try {
        off();
      } catch {}
    }
  }

  private bind(target: EventTargetLike | null, type: string, debounceMs: number): void {
    if (!target) return;
    const handler = () => this.schedule(debounceMs);
    target.addEventListener(type, handler);
    this.cleanups.push(() => {
      try {
        target.removeEventListener(type, handler);
      } catch {}
    });
  }

  private schedule(debounceMs: number): void {
    this.clearTimer();
    if (debounceMs <= 0) {
      this.onWake();
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onWake();
    }, debounceMs);
  }

  private clearTimer(): void {
    if (!this.debounceTimer) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }
}
