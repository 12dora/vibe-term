import {
  type SelectionLineModel,
  type SelectionMode,
  type SelectionPoint,
  type SelectionState,
  createEmptySelectionState,
  hasSelection,
  projectSelectionRects,
  clearSelection as resetSelectionData,
  resolvePointerSelection,
  serializeSelectionText,
  updateSelectionFocus,
} from './selection-model';
import type { GhosttySelectionRect } from './types';

const AUTO_SCROLL_INTERVAL_MS = 48;

type PointerDragState = {
  active: boolean;
  moved: boolean;
  mode: SelectionMode;
  lastClientX: number | null;
  lastClientY: number | null;
  lastPoint: SelectionPoint | null;
};

export type SelectionHostContext = {
  getLineModel(line: number): SelectionLineModel;
  hitTest(clientX: number, clientY: number): SelectionPoint | null;
  getScreenBounds(): { top: number; bottom: number } | null;
  // 返回视口偏移是否真的变了：贴顶 / 贴底时滚动是空操作，本 tick 无需重绘。
  scrollViewportBy(delta: number): boolean;
  render(): void;
  renderSelection(): void;
};

// 指针拖拽结束后的处置：ignored=非本次拖拽的事件；clear=原地单击应清空选择；
// keep=保留选择并重绘。清空要连带重置鼠标/输入侧状态，故交回宿主执行。
export type PointerDragEnd = 'ignored' | 'clear' | 'keep';

export function selectionModeFromClickDetail(detail: number): SelectionMode {
  if (detail >= 3) {
    return 'line';
  }
  if (detail === 2) {
    return 'word';
  }
  return 'character';
}

function samePoint(point: SelectionPoint, previous: SelectionPoint | null): boolean {
  return previous !== null && previous.line === point.line && previous.col === point.col;
}

function createPointerDragState(): PointerDragState {
  return {
    active: false,
    moved: false,
    mode: 'character',
    lastClientX: null,
    lastClientY: null,
    lastPoint: null,
  };
}

// 文本选择状态机：锚点/焦点、指针拖拽与拖出视口后的自动滚动。
export class TerminalSelection {
  private state: SelectionState = createEmptySelectionState();
  private drag: PointerDragState = createPointerDragState();
  private autoScrollTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly context: SelectionHostContext) {}

  get dragging(): boolean {
    return this.drag.active;
  }

  hasSelection(): boolean {
    return hasSelection(this.state);
  }

  getText(): string | null {
    if (!hasSelection(this.state)) {
      return null;
    }

    return serializeSelectionText(this.state, (line) => this.context.getLineModel(line));
  }

  projectRects(offset: number, rows: number): GhosttySelectionRect[] {
    return projectSelectionRects(this.state, offset, rows, (line) =>
      this.context.getLineModel(line)
    );
  }

  reset(): void {
    this.state = resetSelectionData();
    this.drag = createPointerDragState();
    this.stopAutoScroll();
  }

  // 宿主销毁后 WASM 句柄与 render-state 已释放，任何回调都会打到悬空资源上：
  // 停掉自动滚动并让所有入口彻底失效。
  dispose(): void {
    this.disposed = true;
    this.drag.active = false;
    this.stopAutoScroll();
  }

  begin(clientX: number, clientY: number, mode: SelectionMode): boolean {
    if (this.disposed) {
      return false;
    }

    const point = this.context.hitTest(clientX, clientY);
    if (!point) {
      return false;
    }

    this.drag = {
      active: true,
      moved: false,
      mode,
      lastClientX: clientX,
      lastClientY: clientY,
      lastPoint: point,
    };
    this.state = resolvePointerSelection(
      this.state,
      {
        ...point,
        mode,
      },
      (line) => this.context.getLineModel(line)
    );
    // 按下点必然落在选择表面内，这里起不了自动滚动；退化尺寸（隐藏面板、0 高度）下
    // 反而会起一个没有后续指针输入喂养、永不停止的 interval，故只由 update 驱动。
    this.context.render();
    return true;
  }

  update(clientX: number, clientY: number): void {
    if (this.disposed || !this.drag.active) {
      return;
    }

    const point = this.context.hitTest(clientX, clientY);
    this.drag.lastClientX = clientX;
    this.drag.lastClientY = clientY;

    // 落在同一个 cell 的移动不改变选区：直接跳过，避免每个 mousemove 都触发重绘。
    if (point && !samePoint(point, this.drag.lastPoint)) {
      this.drag.lastPoint = point;
      this.state = updateSelectionFocus(this.state, point, (line) =>
        this.context.getLineModel(line)
      );
      // 拖拽期间只有选区矩形在变：走 rAF 合并的选区层重绘，不跑全渲染。
      this.context.renderSelection();
    }
    if (point) {
      this.drag.moved = true;
    }

    this.updateAutoScroll();
  }

  finishPointerDrag(event: MouseEvent): PointerDragEnd {
    if (this.disposed || !this.drag.active || event.button !== 0) {
      return 'ignored';
    }

    this.drag.lastClientX = event.clientX;
    this.drag.lastClientY = event.clientY;
    this.stopAutoScroll();

    const shouldClear =
      this.drag.mode === 'character' &&
      !this.drag.moved &&
      this.state.anchor?.line === this.state.focus?.line &&
      this.state.anchor?.col === this.state.focus?.col;
    this.drag.active = false;

    return shouldClear ? 'clear' : 'keep';
  }

  endDrag(): void {
    this.stopAutoScroll();
    this.drag.active = false;
  }

  private stopAutoScroll(): void {
    if (this.autoScrollTimer === null) {
      return;
    }

    clearInterval(this.autoScrollTimer);
    this.autoScrollTimer = null;
  }

  private updateAutoScroll(): void {
    if (this.disposed || !this.drag.active || this.drag.lastClientY === null) {
      this.stopAutoScroll();
      return;
    }

    const bounds = this.context.getScreenBounds();
    if (!bounds) {
      this.stopAutoScroll();
      return;
    }

    const outsideViewport =
      this.drag.lastClientY < bounds.top || this.drag.lastClientY > bounds.bottom;
    if (!outsideViewport) {
      this.stopAutoScroll();
      return;
    }

    if (this.autoScrollTimer !== null) {
      return;
    }

    this.autoScrollTimer = setInterval(() => {
      this.stepAutoScroll();
    }, AUTO_SCROLL_INTERVAL_MS);
  }

  private stepAutoScroll(): void {
    if (
      this.disposed ||
      !this.drag.active ||
      this.drag.lastClientX === null ||
      this.drag.lastClientY === null
    ) {
      this.stopAutoScroll();
      return;
    }

    const bounds = this.context.getScreenBounds();
    if (!bounds) {
      this.stopAutoScroll();
      return;
    }

    const delta = this.autoScrollDelta(bounds);
    if (delta === 0) {
      this.stopAutoScroll();
      return;
    }

    // 只有真滚动了才跑全渲染刷新视口；命中测试必须排在渲染之后，才看得到新的视口偏移。
    if (this.context.scrollViewportBy(delta)) {
      this.context.render();
    }
    this.trackAutoScrollFocus(this.drag.lastClientX, this.drag.lastClientY);
  }

  private autoScrollDelta(bounds: { top: number; bottom: number }): number {
    if (this.drag.lastClientY === null) {
      return 0;
    }
    if (this.drag.lastClientY < bounds.top) {
      return -1;
    }
    return this.drag.lastClientY > bounds.bottom ? 1 : 0;
  }

  // 焦点跟随滚动后的新视口。焦点未跨 cell 则连选区层都不用重画。
  private trackAutoScrollFocus(clientX: number, clientY: number): void {
    const point = this.context.hitTest(clientX, clientY);
    if (!point) {
      return;
    }

    this.drag.moved = true;
    if (samePoint(point, this.drag.lastPoint)) {
      return;
    }

    this.state = updateSelectionFocus(this.state, point, (line) => this.context.getLineModel(line));
    this.drag.lastPoint = point;
    this.context.renderSelection();
  }
}
