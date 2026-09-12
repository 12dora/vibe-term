// 网络恢复唤醒：`online`、`navigator.connection` 的 `change`、以及 iOS 上两者都没有时的
// 可见前台 liveness。退避已经排到封顶间隔时干等一个整间隔纯属浪费，网络一回来就立刻醒一次。
// 非浏览器宿主（bun / node）事件源都取不到，install 后就是空操作。

/** 事件源的最小结构子集（`window` / `navigator.connection` / `document` 都满足）。 */
interface EventTargetLike {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}

interface DocumentLike extends EventTargetLike {
  visibilityState: string;
}

/** `navigator.connection` 的 `change` 抖动很密，去抖后再唤醒（与直连载体同一节奏）。 */
export const NETWORK_CHANGE_DEBOUNCE_MS = 800;
/** 前台怀疑链路有问题时的探测间隔；健康时不额外发 PING，走常规 PONG。 */
export const FOREGROUND_LIVENESS_INTERVAL_MS = 2500;
/** 定时器晚于间隔这么多，视为事件循环被冻过（iOS 切网常见）。 */
export const FOREGROUND_LIVENESS_DRIFT_MS = 1000;

export interface NetworkWakeClock {
  now(): number;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

const defaultClock: NetworkWakeClock = {
  now: () => Date.now(),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (id) => {
    clearInterval(id as ReturnType<typeof setInterval>);
  },
};

function windowEventSource(): EventTargetLike | null {
  const target = (globalThis as { window?: Partial<EventTargetLike> }).window;
  if (!target || typeof target.addEventListener !== 'function') return null;
  return target as EventTargetLike;
}

function documentEventSource(): DocumentLike | null {
  const doc = (globalThis as { document?: Partial<DocumentLike> }).document;
  if (!doc || typeof doc.addEventListener !== 'function') return null;
  return doc as DocumentLike;
}

function connectionEventSource(): EventTargetLike | null {
  const nav = (globalThis as { navigator?: { connection?: unknown } }).navigator;
  const conn = nav?.connection as Partial<EventTargetLike> | undefined;
  if (!conn || typeof conn.addEventListener !== 'function') return null;
  return conn as EventTargetLike;
}

function navigatorOnline(): boolean | null {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  if (!nav || typeof nav.onLine !== 'boolean') return null;
  return nav.onLine;
}

function documentVisibility(): 'visible' | 'hidden' | null {
  const doc = documentEventSource();
  if (!doc || typeof doc.visibilityState !== 'string') return null;
  return doc.visibilityState === 'hidden' ? 'hidden' : 'visible';
}

export class NetworkWakeListeners {
  private readonly cleanups: Array<() => void> = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watchTimer: unknown = null;
  private lastTickAt = 0;
  private trouble = false;
  private readonly clock: NetworkWakeClock;

  constructor(
    private readonly onWake: () => void,
    clock: NetworkWakeClock = defaultClock
  ) {
    this.clock = clock;
  }

  /** 幂等：已装过就不重复装。 */
  install(): void {
    if (this.cleanups.length > 0) return;
    this.bind(windowEventSource(), 'online', 0);
    this.bind(windowEventSource(), 'pageshow', 0);
    // Wi-Fi ↔ 蜂窝切换通常不触发 `online`，有 Network Information API 时才听 change。
    this.bind(connectionEventSource(), 'change', NETWORK_CHANGE_DEBOUNCE_MS);
    this.bindVisibility();
    this.bind(windowEventSource(), 'offline', 0, () => {
      this.trouble = true;
    });
    if (documentVisibility() === 'visible') this.startWatch();
  }

  dispose(): void {
    this.clearTimer();
    this.stopWatch();
    this.trouble = false;
    this.lastTickAt = 0;
    for (const off of this.cleanups.splice(0)) {
      try {
        off();
      } catch {}
    }
  }

  /** 测试用：当前是否处于「怀疑链路有问题、走 2–3 s 探测」状态。 */
  get suspect(): boolean {
    return this.trouble;
  }

  private bind(
    target: EventTargetLike | null,
    type: string,
    debounceMs: number,
    beforeWake?: () => void
  ): void {
    if (!target) return;
    const handler = () => {
      beforeWake?.();
      this.schedule(debounceMs);
    };
    target.addEventListener(type, handler);
    this.cleanups.push(() => {
      try {
        target.removeEventListener(type, handler);
      } catch {}
    });
  }

  private bindVisibility(): void {
    const doc = documentEventSource();
    if (!doc) return;
    const handler = () => {
      if (doc.visibilityState === 'hidden') {
        this.stopWatch();
        return;
      }
      this.startWatch();
      this.schedule(0);
    };
    doc.addEventListener('visibilitychange', handler);
    this.cleanups.push(() => {
      try {
        doc.removeEventListener('visibilitychange', handler);
      } catch {}
    });
  }

  private startWatch(): void {
    if (this.watchTimer != null) return;
    this.lastTickAt = this.clock.now();
    this.watchTimer = this.clock.setInterval(() => this.tick(), FOREGROUND_LIVENESS_INTERVAL_MS);
  }

  private stopWatch(): void {
    if (this.watchTimer == null) return;
    this.clock.clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.lastTickAt = 0;
  }

  private tick(): void {
    if (documentVisibility() !== 'visible') return;
    const now = this.clock.now();
    const drifted =
      this.lastTickAt > 0 &&
      now - this.lastTickAt - FOREGROUND_LIVENESS_INTERVAL_MS >= FOREGROUND_LIVENESS_DRIFT_MS;
    const offline = navigatorOnline() === false;
    this.lastTickAt = now;
    if (offline || drifted) this.trouble = true;
    if (!this.trouble) return;
    this.onWake();
    if (!offline && !drifted) this.trouble = false;
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
