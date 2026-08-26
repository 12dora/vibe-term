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
};

export type SelectionHostContext = {
  getLineModel(line: number): SelectionLineModel;
  hitTest(clientX: number, clientY: number): SelectionPoint | null;
  getScreenBounds(): { top: number; bottom: number } | null;
  scrollViewportBy(delta: number): void;
  render(): void;
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

function createPointerDragState(): PointerDragState {
  return {
    active: false,
    moved: false,
    mode: 'character',
    lastClientX: null,
    lastClientY: null,
  };
}

// 文本选择状态机：锚点/焦点、指针拖拽与拖出视口后的自动滚动。
export class TerminalSelection {
  private state: SelectionState = createEmptySelectionState();
  private drag: PointerDragState = createPointerDragState();
  private autoScrollTimer: ReturnType<typeof setInterval> | null = null;

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

  begin(clientX: number, clientY: number, mode: SelectionMode): boolean {
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
    };
    this.state = resolvePointerSelection(
      this.state,
      {
        ...point,
        mode,
      },
      (line) => this.context.getLineModel(line)
    );
    this.updateAutoScroll();
    this.context.render();
    return true;
  }

  update(clientX: number, clientY: number): void {
    if (!this.drag.active) {
      return;
    }

    const point = this.context.hitTest(clientX, clientY);
    this.drag.lastClientX = clientX;
    this.drag.lastClientY = clientY;

    if (point) {
      this.drag.moved = true;
      this.state = updateSelectionFocus(this.state, point, (line) =>
        this.context.getLineModel(line)
      );
      this.context.render();
    }

    this.updateAutoScroll();
  }

  finishPointerDrag(event: MouseEvent): PointerDragEnd {
    if (!this.drag.active || event.button !== 0) {
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

  stopAutoScroll(): void {
    if (this.autoScrollTimer === null) {
      return;
    }

    clearInterval(this.autoScrollTimer);
    this.autoScrollTimer = null;
  }

  private updateAutoScroll(): void {
    if (!this.drag.active || this.drag.lastClientY === null) {
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
    if (!this.drag.active || this.drag.lastClientX === null || this.drag.lastClientY === null) {
      this.stopAutoScroll();
      return;
    }

    const bounds = this.context.getScreenBounds();
    if (!bounds) {
      this.stopAutoScroll();
      return;
    }

    let delta = 0;
    if (this.drag.lastClientY < bounds.top) {
      delta = -1;
    } else if (this.drag.lastClientY > bounds.bottom) {
      delta = 1;
    }

    if (delta === 0) {
      this.stopAutoScroll();
      return;
    }

    this.context.scrollViewportBy(delta);
    this.context.render();

    const point = this.context.hitTest(this.drag.lastClientX, this.drag.lastClientY);
    if (!point) {
      return;
    }

    this.state = updateSelectionFocus(this.state, point, (line) => this.context.getLineModel(line));
    this.drag.moved = true;
    this.context.render();
  }
}
