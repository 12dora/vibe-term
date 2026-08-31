import type { TerminalSizeSnapshot, TimedTerminalSizeSnapshot } from '../utils/resizeSyncGuards';
import { type TerminalCellSize, computeContainerSize } from './terminalMetrics';

export type TerminalResizeKind = 'resize' | 'sync';
export type TerminalSizingMode = 'report' | 'follow' | 'local';

/** 上报前的准入条件快照，随渲染变化 */
export interface TerminalResizeGate {
  deviceId: string;
  paneId: string;
  deviceConnected: boolean;
  isSelectionInvalid: boolean;
  sizingMode: TerminalSizingMode;
}

export interface ResizeMeasurableTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly element: unknown;
  readonly _core?: {
    _renderService?: { dimensions?: { css?: { cell?: TerminalCellSize } } };
  };
  resize: (cols: number, rows: number) => void;
}

export interface ResizeDimensionProposer {
  proposeDimensions: () => { cols: number } | null | undefined;
}

export interface TerminalResizeHandlers {
  onResize: (cols: number, rows: number) => void;
  onSync: (cols: number, rows: number) => void;
  onResizeSettled?: (cols: number, rows: number) => void;
}

export interface TerminalResizeReporterDeps {
  /**
   * 准入条件在**执行时**取，不在排队时捕获：防抖任务排队后 sizingMode 可能已经
   * 从 report 翻成 local（保活实例被切到后台），用旧闸门跑就会替隐藏实例上报尺寸。
   */
  getGate: () => TerminalResizeGate;
  getTerminal: () => ResizeMeasurableTerminal | null;
  getProposer: () => ResizeDimensionProposer | null;
  getContainerRect: () => { width: number; height: number } | null;
  getHandlers: () => TerminalResizeHandlers;
  now?: () => number;
}

export interface MutableBox<T> {
  current: T;
}

export interface ResizeReportGuardInput {
  gate: TerminalResizeGate;
  kind: TerminalResizeKind;
  force: boolean;
  now: number;
  suppressUntil: number;
}

/**
 * follow 模式下 pane 的 cols/rows 由 tmux layout 决定，容器像素测量不可作为尺寸来源；
 * local 模式（保活池里的隐藏实例）照常测量并对齐本地行列，只是不上报，见 emit 前的短路；
 * sync 即使在 isSelectionInvalid 时也放行——尺寸同步是基础功能，只有用户输入受限。
 */
export function shouldAttemptResizeReport({
  gate,
  kind,
  force,
  now,
  suppressUntil,
}: ResizeReportGuardInput): boolean {
  if (gate.sizingMode === 'follow') {
    return false;
  }
  if (!gate.deviceId || !gate.paneId || !gate.deviceConnected) {
    return false;
  }
  if (gate.isSelectionInvalid && kind !== 'sync') {
    return false;
  }
  if (!force && now < suppressUntil) {
    return false;
  }
  return true;
}

export interface TerminalResizeReportRequest {
  kind: TerminalResizeKind;
  /** 缺省取 deps.getGate()（生产路径）；显式传入仅用于测试单点判定 */
  gate?: TerminalResizeGate;
  force?: boolean;
}

export class TerminalResizeReporter {
  readonly lastReportedSize: MutableBox<TerminalSizeSnapshot | null> = { current: null };
  /** 最近一次 measure 读到的容器像素尺寸，供 ResizeObserver 首次投递去重 */
  readonly lastMeasuredRect: MutableBox<{ width: number; height: number } | null> = {
    current: null,
  };
  readonly pendingLocalSize: MutableBox<TimedTerminalSizeSnapshot | null> = { current: null };
  readonly suppressLocalResizeUntil: MutableBox<number> = { current: 0 };

  private readonly deps: TerminalResizeReporterDeps;

  constructor(deps: TerminalResizeReporterDeps) {
    this.deps = deps;
  }

  measure(): TerminalSizeSnapshot | null {
    const terminal = this.deps.getTerminal();
    const proposer = this.deps.getProposer();
    if (!terminal || !proposer || !terminal.element) {
      return null;
    }

    const rect = this.deps.getContainerRect();
    if (!rect) {
      return null;
    }

    this.lastMeasuredRect.current = rect;
    return computeContainerSize({
      rect,
      cell: terminal._core?._renderService?.dimensions?.css?.cell,
      proposeDimensions: () => proposer.proposeDimensions(),
    });
  }

  report({
    kind,
    gate = this.deps.getGate(),
    force = false,
  }: TerminalResizeReportRequest): boolean {
    const now = this.now();
    const allowed = shouldAttemptResizeReport({
      gate,
      kind,
      force,
      now,
      suppressUntil: this.suppressLocalResizeUntil.current,
    });
    if (!allowed) {
      return false;
    }

    const terminal = this.deps.getTerminal();
    if (!terminal) {
      return false;
    }

    const measured = this.measure();
    if (!measured) {
      return false;
    }

    const { cols, rows } = measured;
    applyTerminalSize(terminal, cols, rows);

    if (gate.sizingMode === 'local') {
      return true;
    }

    const last = this.lastReportedSize.current;
    if (!force && last && last.cols === cols && last.rows === rows) {
      return true;
    }

    this.emit(kind, cols, rows);
    this.lastReportedSize.current = { cols, rows };
    this.pendingLocalSize.current = { cols, rows, at: this.now() };
    this.deps.getHandlers().onResizeSettled?.(cols, rows);
    return true;
  }

  private emit(kind: TerminalResizeKind, cols: number, rows: number): void {
    const handlers = this.deps.getHandlers();
    if (kind === 'sync') {
      handlers.onSync(cols, rows);
      return;
    }
    handlers.onResize(cols, rows);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function applyTerminalSize(terminal: ResizeMeasurableTerminal, cols: number, rows: number): void {
  if (terminal.cols === cols && terminal.rows === rows) {
    return;
  }
  terminal.resize(cols, rows);
}
