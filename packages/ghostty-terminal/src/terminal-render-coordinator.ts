import type { CanvasRenderer } from './canvas-renderer';
import type { FileLinkContext } from './file-path';
import type { GhosttyBindings } from './ghostty-wasm';
import {
  type GhosttyRenderStateResources,
  iterateRows,
  readRenderSnapshotMeta,
  updateRenderState,
} from './render-state';
import {
  EMPTY_SELECTION_LINE_MODEL,
  type SelectionLineModel,
  type SelectionPoint,
  buildLineModel,
} from './selection-model';
import { normalizeVisibleLines } from './terminal-buffer';
import { DEFAULT_ROWS } from './terminal-constants';
import type { TerminalScrollbarState } from './terminal-dom';
import { LinkMatchCache, collectLinkUnderlineSegments, findLinkAtPoint } from './terminal-links';
import type { TerminalLinkHit } from './terminal-pointer';
import { TerminalRenderLoop, ThrottledTask } from './terminal-render-loop';
import type {
  GhosttyCellDimensions,
  GhosttyRenderCell,
  GhosttyRenderCursor,
  GhosttyRenderRow,
  GhosttySelectionRect,
  GhosttyTheme,
} from './types';

// 链接下划线重算节流：只扫可见区，且相邻两次重算至少间隔此值（trailing 保证终态正确）。
const LINK_OVERLAY_THROTTLE_MS = 150;
const LINK_MATCH_CACHE_LIMIT = 300;

// 一帧渲染产出的、宿主需要同步的外部状态。
export type RenderSnapshot = {
  cols: number;
  rows: number;
  scrollbar: TerminalScrollbarState;
  visibleLines: string[];
  selectionText: string | null;
};

export type RenderCoordinatorHost = {
  cellDimensions(): GhosttyCellDimensions;
  screenBounds(): { left: number; top: number } | null;
  viewportCols(): number;
  viewportRows(): number;
  selectionRects(offset: number, rows: number): GhosttySelectionRect[];
  selectionText(): string | null;
  selectionColor(): string;
  fileLinkContext(): FileLinkContext | null;
  onSnapshot(snapshot: RenderSnapshot): void;
  onSelectionText(text: string | null): void;
};

// 渲染编排：拉取 WASM 快照 → 维护绝对行号的行模型缓存 → 交给 CanvasRenderer 出帧，
// 并按节流重算链接下划线 overlay。行模型缓存同时服务选择文本、命中高亮与链接检测。
export class TerminalRenderCoordinator {
  private renderer: CanvasRenderer | null = null;
  private readonly lineCache = new Map<number, SelectionLineModel>();
  // 行模型按 cells 数组的对象身份缓存：render-state 对内容未变的行会复用同一个 cells
  // 数组，于是整帧只为真正变化的行重建模型；数组换新即自动 miss，不存在过期风险。
  private readonly lineModelByCells = new WeakMap<GhosttyRenderCell[], SelectionLineModel>();
  private readonly linkMatchCache = new LinkMatchCache(LINK_MATCH_CACHE_LIMIT);
  private readonly linkOverlayTask = new ThrottledTask(LINK_OVERLAY_THROTTLE_MS, () => {
    this.updateLinkOverlay();
  });
  private readonly loop = new TerminalRenderLoop(() => {
    this.renderNow();
  });
  private selectionFrame: number | null = null;
  private linkOverlayDrawnOffset = -1;
  private viewportOffset = 0;
  private viewportRows = DEFAULT_ROWS;
  private renderedRows: GhosttyRenderRow[] = [];
  // 每帧缓存的光标快照，供 getCursorViewportRect / IME 定位读取，避免重复消费 dirty。
  private lastCursor: GhosttyRenderCursor | null = null;

  constructor(
    private readonly bindings: GhosttyBindings,
    private readonly terminalHandle: number,
    private readonly renderState: GhosttyRenderStateResources,
    private readonly host: RenderCoordinatorHost
  ) {}

  attach(renderer: CanvasRenderer): void {
    this.renderer = renderer;
  }

  get cursor(): GhosttyRenderCursor | null {
    return this.lastCursor;
  }

  get rendererKind(): string {
    return this.renderer?.kind ?? 'unknown';
  }

  // 最近一帧的视口几何：命中测试与 e2e 诊断（apps/fe/tests 的 readTerminalInternals）读它。
  get lastViewportRows(): number {
    return this.viewportRows;
  }

  get lastRenderedRows(): GhosttyRenderRow[] {
    return this.renderedRows;
  }

  schedule(): void {
    this.loop.schedule();
  }

  // 选区拖拽专用：本帧只有选区矩形变了，复用上一次全渲染留下的 renderedRows / lineCache
  // 重画选区层，不碰 WASM，也不重扫任何 cell；每帧最多一次。
  scheduleSelectionRepaint(): void {
    if (this.selectionFrame !== null) {
      return;
    }

    this.selectionFrame = requestAnimationFrame(() => {
      this.selectionFrame = null;
      const renderer = this.renderer;
      if (!renderer) {
        return;
      }

      renderer.drawSelectionOnly(
        this.host.selectionRects(this.viewportOffset, this.viewportRows),
        this.host.selectionColor()
      );
      this.host.onSelectionText(this.host.selectionText());
    });
  }

  // 标记本次渲染必须全画并立即同步执行（不等 rAF）：DOM 重插入或容器尺寸变化后
  // canvas 位图可能已被清空，但内核未必同步报 dirty='full'（issue #45 bug 3）。
  forceFullRepaint(): void {
    this.loop.requestFullRepaint();
    this.renderNow();
  }

  cancelPending(): void {
    this.loop.cancelPending();
    this.cancelSelectionRepaint();
  }

  setTheme(theme: GhosttyTheme): void {
    this.renderer?.setTheme(theme);
    this.loop.schedule();
  }

  // resize / reset 会重排软换行与 scrollback 行号，按绝对行号缓存的行模型全部作废。
  invalidateLines(): void {
    this.lineCache.clear();
  }

  getLineModel(line: number): SelectionLineModel {
    const cached = this.lineCache.get(line);
    if (cached) {
      return cached;
    }

    const visibleRow = this.renderedRows[line - this.viewportOffset];
    return visibleRow
      ? buildLineModel(visibleRow.cells, visibleRow.wrap)
      : EMPTY_SELECTION_LINE_MODEL;
  }

  hitTest(clientX: number, clientY: number): SelectionPoint | null {
    const rect = this.host.screenBounds();
    if (!rect) {
      return null;
    }

    const { width, height } = this.host.cellDimensions();
    if (width <= 0 || height <= 0) {
      return null;
    }

    const maxCol = Math.max(this.host.viewportCols() - 1, 0);
    const maxRow = Math.max(this.viewportRows - 1, 0);
    const col = Math.max(0, Math.min(maxCol, Math.floor((clientX - rect.left) / width)));
    const row = Math.max(0, Math.min(maxRow, Math.floor((clientY - rect.top) / height)));

    return { line: this.viewportOffset + row, col };
  }

  linkAt(clientX: number, clientY: number): TerminalLinkHit | null {
    const point = this.hitTest(clientX, clientY);
    if (!point) {
      return null;
    }

    return findLinkAtPoint({
      line: point.line,
      col: point.col,
      getLineModel: (line) => this.getLineModel(line),
      cache: this.linkMatchCache,
      fileLinkContext: this.host.fileLinkContext(),
    });
  }

  scheduleLinkOverlayUpdate(): void {
    this.linkOverlayTask.schedule();
  }

  cancelLinkOverlay(): void {
    this.linkOverlayTask.cancel();
    this.linkMatchCache.clear();
  }

  renderNow(): void {
    const renderer = this.renderer;
    if (!renderer) {
      return;
    }

    // 全渲染本身会重画选区层，排队中的选区帧就是多余的。
    this.cancelSelectionRepaint();

    // 本帧若被 forceFullRepaint 标记，传给 renderer 让它绕过 dirty='clean' 早退
    //（issue #45 bug 3）。
    const forceFull = this.loop.consumeForceFull();

    const scrollbar = this.bindings.readScrollbar(this.terminalHandle);
    const fallbackRows = Math.max(1, scrollbar.len || this.host.viewportRows());

    updateRenderState(this.renderState, this.terminalHandle);
    // 先取行、再取 meta：render-state 会在完整迭代结束后按逐 cell 比对把内核恒报的
    // dirty='full' 降级成 'partial'/'clean'，meta 必须在那之后读才拿得到降级结果。
    const rows = Array.from(iterateRows(this.renderState));
    const meta = readRenderSnapshotMeta(this.renderState);

    this.lastCursor = meta.cursor;
    this.viewportOffset = scrollbar.offset;
    this.viewportRows = Math.max(2, meta.rows || fallbackRows);
    this.renderedRows = rows;
    for (const row of rows) {
      this.lineCache.set(scrollbar.offset + row.y, this.lineModelFor(row));
    }

    const selectionRects = this.host.selectionRects(this.viewportOffset, this.viewportRows);
    const selectionText = this.host.selectionText();

    renderer.render({
      meta,
      rows,
      cellDimensions: this.host.cellDimensions(),
      selectionRects,
      selectionColor: this.host.selectionColor(),
      forceFull,
    });

    this.host.onSnapshot({
      cols: Math.max(2, meta.cols),
      rows: this.viewportRows,
      scrollbar,
      visibleLines: normalizeVisibleLines(rows, this.viewportRows),
      selectionText,
    });

    // 滚动后旧下划线位置立刻失效：先清空避免错位残影，再等节流重算。
    if (this.linkOverlayDrawnOffset !== -1 && this.linkOverlayDrawnOffset !== scrollbar.offset) {
      this.linkOverlayDrawnOffset = -1;
      renderer.clearLinkUnderlines();
    }
    this.scheduleLinkOverlayUpdate();
  }

  dispose(): void {
    this.cancelSelectionRepaint();
    this.renderer?.dispose();
    this.renderer = null;
    this.lineCache.clear();
    this.renderedRows = [];
  }

  private cancelSelectionRepaint(): void {
    if (this.selectionFrame === null) {
      return;
    }

    cancelAnimationFrame(this.selectionFrame);
    this.selectionFrame = null;
  }

  private lineModelFor(row: GhosttyRenderRow): SelectionLineModel {
    const cached = this.lineModelByCells.get(row.cells);
    if (cached && cached.wrappedToNext === row.wrap) {
      return cached;
    }

    const model = buildLineModel(row.cells, row.wrap);
    this.lineModelByCells.set(row.cells, model);
    return model;
  }

  private updateLinkOverlay(): void {
    const renderer = this.renderer;
    if (!renderer) {
      return;
    }

    const offset = this.viewportOffset;
    const segments = collectLinkUnderlineSegments({
      offset,
      rows: this.viewportRows,
      getLineModel: (line) => this.getLineModel(line),
      cache: this.linkMatchCache,
      fileLinkContext: this.host.fileLinkContext(),
    });

    this.linkOverlayDrawnOffset = offset;
    renderer.drawLinkUnderlines(segments);
  }
}
