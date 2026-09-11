// 恢复信号源：`visibilitychange` 与 `pageshow`（bfcache）。
// 与 `network-wake.ts` 同一形状：宿主拿不到 document / window 时装了就是空操作。
//
// 为什么两条都要：iOS 从 bfcache 恢复不一定伴随 visibilitychange，而这恰恰是链路最可能
// 已经断掉的一种恢复。非 persisted 的 pageshow 是普通导航，与恢复无关，不上报。

interface DocumentLike {
  visibilityState: string;
  addEventListener(type: string, handler: () => void): void;
  removeEventListener(type: string, handler: () => void): void;
}

interface WindowLike {
  addEventListener(type: string, handler: (event?: unknown) => void): void;
  removeEventListener(type: string, handler: (event?: unknown) => void): void;
}

export interface ResumeSignalHandlers {
  /** 可见性变化（含**转入后台**）：宿主据此换心跳节奏。 */
  onVisibilityChange(): void;
  /** 页面回到前台 / 从 bfcache 恢复。 */
  onResume(): void;
}

function documentSource(): DocumentLike | null {
  const doc = (globalThis as { document?: Partial<DocumentLike> }).document;
  if (!doc || typeof doc.addEventListener !== 'function') return null;
  return doc as DocumentLike;
}

function windowSource(): WindowLike | null {
  const win = (globalThis as { window?: Partial<WindowLike> }).window;
  if (!win || typeof win.addEventListener !== 'function') return null;
  return win as WindowLike;
}

export class ResumeSignalListeners {
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly handlers: ResumeSignalHandlers) {}

  /** 幂等：已装过就不重复装。 */
  install(): void {
    if (this.cleanups.length > 0) return;

    const doc = documentSource();
    if (doc) {
      const onVisibility = () => {
        this.handlers.onVisibilityChange();
        if (doc.visibilityState !== 'visible') return;
        this.handlers.onResume();
      };
      doc.addEventListener('visibilitychange', onVisibility);
      this.cleanups.push(() => doc.removeEventListener('visibilitychange', onVisibility));
    }

    const win = windowSource();
    if (win) {
      const onPageShow = (event?: unknown) => {
        if ((event as { persisted?: unknown } | undefined)?.persisted !== true) return;
        this.handlers.onVisibilityChange();
        this.handlers.onResume();
      };
      win.addEventListener('pageshow', onPageShow);
      this.cleanups.push(() => win.removeEventListener('pageshow', onPageShow));
    }
  }

  dispose(): void {
    for (const off of this.cleanups.splice(0)) {
      try {
        off();
      } catch {}
    }
  }

  /** 是否已装上监听（测试与幂等判定用）。 */
  get installed(): boolean {
    return this.cleanups.length > 0;
  }
}

/**
 * 恢复探测的节流闸。回前台时 visibilitychange / pageshow / online 往往在同一帧连着到，
 * 一次探测就够，别把三条信号变成三帧 PING。
 */
export const RESUME_PROBE_THROTTLE_MS = 1000;

export class ResumeProbeGate {
  private lastAt = 0;

  constructor(private readonly throttleMs: number = RESUME_PROBE_THROTTLE_MS) {}

  allow(now: number = Date.now()): boolean {
    if (now - this.lastAt < this.throttleMs) return false;
    this.lastAt = now;
    return true;
  }
}
