const MIN_HISTORY_DEADLINE_MS = 15_000;
const MAX_HISTORY_DEADLINE_MS = 60_000;
const HISTORY_DEADLINE_LATENCY_FACTOR = 8;
/** 预取带的下限：视口不足一屏高（分屏里的窄 pane）时至少留 3 行的提前量 */
const HISTORY_PREFETCH_MIN_ROWS = 3;

/** 在途请求的放弃时限：按链路 RTT 放大，夹在 15s~60s 之间 */
export function historyRequestDeadlineMs(latencyMs: number | null | undefined): number {
  return Math.min(
    MAX_HISTORY_DEADLINE_MS,
    Math.max(MIN_HISTORY_DEADLINE_MS, (latencyMs ?? 0) * HISTORY_DEADLINE_LATENCY_FACTOR)
  );
}

export interface HistoryPrefetchViewport {
  /** 视口顶行在缓冲区里的绝对行号，0 即已经滚到本地回滚的最顶 */
  viewportY: number;
  rows: number;
}

/** 预取带宽度：一屏高度。等滚到顶再取的话每一页都是一次可见的停顿 */
export function historyPrefetchBandRows(rows: number): number {
  const height = Number.isFinite(rows) ? Math.floor(rows) : 0;
  return Math.max(HISTORY_PREFETCH_MIN_ROWS, height);
}

export function withinHistoryPrefetchBand({ viewportY, rows }: HistoryPrefetchViewport): boolean {
  return viewportY <= historyPrefetchBandRows(rows);
}

export interface HistoryPrefetchTimers {
  setTimeout: (handler: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
}

export const browserHistoryPrefetchTimers: HistoryPrefetchTimers = {
  setTimeout: (handler, ms) => window.setTimeout(handler, ms),
  clearTimeout: (id) => {
    window.clearTimeout(id);
  },
};

export interface HistoryPrefetchDeps<Cursor> {
  /** 下一页的游标；null 表示没有更旧的历史，或分页已被预算叫停 */
  getCursor(): Cursor | null;
  /** 当前视口；null 表示终端还没就绪 */
  getViewport(): HistoryPrefetchViewport | null;
  request(cursor: Cursor): void;
  deadlineMs(): number;
  timers?: HistoryPrefetchTimers;
}

/**
 * 向上翻页时的 history 预取。
 *
 * 视口进入「距缓冲区顶部一屏」的带内就发请求；一页到达后若视口仍在带内，**立刻**续发
 * 下一页，不再等下一次滚轮事件——这是「两页在途」在本协议下唯一正确的形态：下一页的
 * 游标（beforeLine）只有在上一页到达后才已知，同时发两条同游标的请求只会拿回两份一样
 * 的页，第二份会被 validateHistoryPage 判成断链并触发整屏重取。续发的页因此与前一页
 * 落在同一个 HISTORY_BATCH_MS 窗口里，由 TerminalSurface 合并成一次重排。
 */
export class HistoryPrefetchController<Cursor> {
  private inFlight = false;
  private deadlineTimer: number | null = null;
  private readonly timers: HistoryPrefetchTimers;

  constructor(private readonly deps: HistoryPrefetchDeps<Cursor>) {
    this.timers = deps.timers ?? browserHistoryPrefetchTimers;
  }

  handleWheel(deltaY: number): void {
    if (deltaY >= 0) return;
    this.tryRequest();
  }

  handlePageArrived(): void {
    this.clearDeadline();
    this.inFlight = false;
    this.tryRequest();
  }

  dispose(): void {
    this.clearDeadline();
    this.inFlight = false;
  }

  private tryRequest(): void {
    if (this.inFlight) return;
    const viewport = this.deps.getViewport();
    if (!viewport || !withinHistoryPrefetchBand(viewport)) return;
    const cursor = this.deps.getCursor();
    if (!cursor) return;
    this.inFlight = true;
    this.deps.request(cursor);
    this.armDeadline();
  }

  private armDeadline(): void {
    this.clearDeadline();
    this.deadlineTimer = this.timers.setTimeout(() => {
      this.deadlineTimer = null;
      this.inFlight = false;
    }, this.deps.deadlineMs());
  }

  private clearDeadline(): void {
    if (this.deadlineTimer === null) return;
    this.timers.clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }
}
