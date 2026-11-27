// 页面活跃度：把 visibilitychange 与 Page Lifecycle（pagehide/pageshow/freeze/resume）合并成一个「是否活跃」判定。
// 移动端锁屏 / 切 App 时只会稳定收到 pagehide 或 freeze（visibilitychange 不一定先到），
// 且后台页面发出的 resize/sync 会被网关当成可见声明重新点亮，所以两处发送方都要共用这套信号。

export type PageLifecycleEvent = 'visibilitychange' | 'pagehide' | 'pageshow' | 'freeze' | 'resume';

interface PageEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface PageActivityDocument extends PageEventTarget {
  readonly visibilityState?: string;
}

export type PageActivityListener = (event: PageLifecycleEvent, active: boolean) => void;

export interface PageActivityTracker {
  isActive(): boolean;
  subscribe(listener: PageActivityListener): () => void;
  dispose(): void;
}

/** pagehide/freeze 在 document、window 上分布不同：document 承载 freeze/resume/visibilitychange，window 承载 pagehide/pageshow */
export function createPageActivityTracker(
  doc: PageActivityDocument | null,
  win: PageEventTarget | null
): PageActivityTracker {
  let suspended = false;
  const listeners = new Set<PageActivityListener>();

  const hidden = (): boolean => doc?.visibilityState === 'hidden';
  const isActive = (): boolean => !suspended && !hidden();

  const handlerFor = (event: PageLifecycleEvent) => () => {
    if (event === 'pagehide' || event === 'freeze') {
      suspended = true;
    } else if (event === 'pageshow' || event === 'resume' || !hidden()) {
      suspended = false;
    }
    const active = isActive();
    for (const listener of [...listeners]) listener(event, active);
  };

  const bindings: Array<[PageEventTarget, PageLifecycleEvent, () => void]> = [];
  const bind = (target: PageEventTarget | null, event: PageLifecycleEvent): void => {
    if (!target) return;
    const handler = handlerFor(event);
    target.addEventListener(event, handler);
    bindings.push([target, event, handler]);
  };
  bind(doc, 'visibilitychange');
  bind(doc, 'freeze');
  bind(doc, 'resume');
  bind(win, 'pagehide');
  bind(win, 'pageshow');

  return {
    isActive,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      for (const [target, event, handler] of bindings) target.removeEventListener(event, handler);
      bindings.length = 0;
      listeners.clear();
    },
  };
}

export type SizeReportKind = 'resize' | 'sync';

export interface SizeReportGate {
  submit(kind: SizeReportKind, cols: number, rows: number): void;
  /** 页面重新活跃后补发被拦下的最新尺寸 */
  flush(): void;
  discard(): void;
}

/**
 * 页面不活跃时 TerminalResizeReporter 仍会量尺寸、改本地网格并记下 lastReportedSize，
 * 恢复可见时 viewport-restore 看到网格 === 容器就不再 sync；所以被拦下的上报必须在这里留存并补发。
 */
export function createSizeReportGate({
  isActive,
  dispatch,
}: {
  isActive: () => boolean;
  dispatch: (kind: SizeReportKind, cols: number, rows: number) => void;
}): SizeReportGate {
  let held: { kind: SizeReportKind; cols: number; rows: number } | null = null;

  return {
    submit(kind, cols, rows) {
      if (!isActive()) {
        held = { kind: held?.kind === 'resize' ? 'resize' : kind, cols, rows };
        return;
      }
      held = null;
      dispatch(kind, cols, rows);
    },
    flush() {
      if (!held || !isActive()) return;
      const pending = held;
      held = null;
      dispatch(pending.kind, pending.cols, pending.rows);
    },
    discard() {
      held = null;
    },
  };
}
