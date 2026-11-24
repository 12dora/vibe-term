import type { GhosttyBindings } from './ghostty-wasm';
import { GraphemeWidthProbe } from './grapheme-width';
import { GHOSTTY_MODE_ALT_SCREEN_LEGACY } from './terminal-constants';
import type { TerminalInputBridge } from './terminal-input-bridge';
import type { RenderSnapshot, TerminalRenderCoordinator } from './terminal-render-coordinator';
import type {
  GhosttyRenderCursor,
  GhosttyRenderRow,
  PredictionCell,
  PredictionFrame,
  PredictionOverlay,
  TerminalPredictionHost,
} from './types';

export type PredictionModeState = {
  altScreen: boolean;
  mouseReporting: boolean;
  synchronizedOutput: boolean;
};

export type PredictionHostDeps = {
  modes(): PredictionModeState;
  applyOverlay(overlay: PredictionOverlay | null): void;
  textWidth(text: string): 1 | 2;
};

export type PredictionRenderInput = {
  cols: number;
  rows: number;
  viewportTop: number;
  viewportAtBottom: boolean;
  cursor: GhosttyRenderCursor | null;
  lines: readonly GhosttyRenderRow[];
};

export function readPredictionCell(
  lines: readonly GhosttyRenderRow[],
  cols: number,
  row: number,
  col: number
): PredictionCell | null {
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || col >= cols) {
    return null;
  }

  const cell = lines[row]?.cells[col];
  if (!cell) {
    return null;
  }
  if (cell.widthKind === 'spacer-tail' || cell.widthKind === 'spacer-head') {
    return { text: '', wide: false };
  }

  return { text: cell.text || ' ', wide: cell.widthKind === 'wide' };
}

// 预测宿主：控制器在每次渲染完成时把「这一帧」的引用交进来（noteRender 只存引用，不分配），
// 帧对象在有订阅者或被 frame() 取用时才构造；格子读取走 cellAt 按需访问渲染行，
// 模式位（alt screen / 鼠标上报 / 同步输出）首次读取时才查内核，且复用输入桥的按代缓存。
// generation 在 reset / resize 时递增，并随下一帧发布：帧内数据与代号始终属于同一次渲染。
export class TerminalPredictionHostImpl implements TerminalPredictionHost {
  private readonly listeners = new Set<(frame: PredictionFrame) => void>();
  private generation = 0;
  private renderedGeneration = 0;
  private cols = 0;
  private rows = 0;
  private viewportTop = 0;
  private viewportAtBottom = true;
  private cursor: GhosttyRenderCursor | null = null;
  private lines: readonly GhosttyRenderRow[] = [];
  private cachedFrame: PredictionFrame | null = null;

  constructor(private readonly deps: PredictionHostDeps) {}

  setOverlay(overlay: PredictionOverlay | null): void {
    this.deps.applyOverlay(overlay);
  }

  onFrame(callback: (frame: PredictionFrame) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  frame(): PredictionFrame | null {
    if (this.cachedFrame) {
      return this.cachedFrame;
    }
    if (!this.cursor) {
      return null;
    }

    this.cachedFrame = this.buildFrame(this.cursor);
    return this.cachedFrame;
  }

  textWidth(text: string): 1 | 2 {
    return this.deps.textWidth(text);
  }

  invalidate(): void {
    this.generation += 1;
  }

  noteRender(input: PredictionRenderInput): void {
    this.cols = input.cols;
    this.rows = input.rows;
    this.viewportTop = input.viewportTop;
    this.viewportAtBottom = input.viewportAtBottom;
    this.cursor = input.cursor;
    this.lines = input.lines;
    this.renderedGeneration = this.generation;
    this.cachedFrame = null;
    if (this.listeners.size === 0) {
      return;
    }

    const frame = this.frame();
    if (!frame) {
      return;
    }
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(frame);
      } catch (error) {
        console.error('[prediction] onFrame listener failed', error);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.cachedFrame = null;
    this.cursor = null;
    this.lines = [];
  }

  private buildFrame(cursor: GhosttyRenderCursor): PredictionFrame {
    const { cols, rows, lines, deps } = this;
    let modes: PredictionModeState | null = null;
    const readModes = (): PredictionModeState => {
      modes ??= deps.modes();
      return modes;
    };

    return {
      cols,
      rows,
      cursor: {
        row: cursor.y ?? 0,
        col: cursor.x ?? 0,
        visible: cursor.visible && cursor.x !== null && cursor.y !== null,
        passwordInput: cursor.passwordInput,
      },
      get altScreen() {
        return readModes().altScreen;
      },
      get mouseReporting() {
        return readModes().mouseReporting;
      },
      get synchronizedOutput() {
        return readModes().synchronizedOutput;
      },
      viewportAtBottom: this.viewportAtBottom,
      viewportTop: this.viewportTop,
      generation: this.renderedGeneration,
      cellAt: (row, col) => readPredictionCell(lines, cols, row, col),
    };
  }
}

// 路由判定只看 1047/1049（滚轮行为不变）；预测回显额外计入旧式 DECSET 47。内核不认 47 时按未开处理。
function isAnyAltScreenActive(input: TerminalInputBridge): boolean {
  if (input.isAltScreenActive()) {
    return true;
  }
  try {
    return input.isModeEnabled(GHOSTTY_MODE_ALT_SCREEN_LEGACY);
  } catch {
    return false;
  }
}

// 控制器侧的预测接线：宿主 + 宽度探针的生命周期，渲染完成 / reset / resize 的钩子都收在这里。
export class TerminalPrediction {
  readonly host: TerminalPredictionHostImpl;
  private readonly widthProbe: GraphemeWidthProbe;
  private disposed = false;

  constructor(
    bindings: GhosttyBindings,
    input: TerminalInputBridge,
    private readonly coordinator: TerminalRenderCoordinator
  ) {
    this.widthProbe = new GraphemeWidthProbe(bindings);
    this.host = new TerminalPredictionHostImpl({
      modes: () => ({
        altScreen: isAnyAltScreenActive(input),
        mouseReporting: input.routingState().mouseReporting,
        synchronizedOutput: input.isSynchronizedOutputActive(),
      }),
      applyOverlay: (overlay) => {
        if (!this.disposed) {
          this.coordinator.predictionTarget?.setPredictionOverlay(overlay);
        }
      },
      textWidth: (text) => this.widthProbe.width(text),
    });
  }

  noteRender({ cols, rows, scrollbar }: RenderSnapshot): void {
    this.host.noteRender({
      cols,
      rows,
      viewportTop: scrollbar.offset,
      viewportAtBottom: scrollbar.offset >= Math.max(0, scrollbar.total - scrollbar.len),
      cursor: this.coordinator.cursor,
      lines: this.coordinator.lastRenderedRows,
    });
  }

  // reset / resize 让此前的绝对坐标全部失效：代号递增（随下一帧发布），已落笔的 overlay 立即擦掉。
  invalidate(): void {
    this.host.invalidate();
    this.host.setOverlay(null);
  }

  dispose(): void {
    this.disposed = true;
    this.host.dispose();
    this.widthProbe.dispose();
  }
}
