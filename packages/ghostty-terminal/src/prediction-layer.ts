import type { LayerSurface } from './canvas-layer-surface';
import type { PredictionOverlay, PredictionOverlayCell } from './types';

export type PredictionPalette = {
  background: string;
  foreground: string;
};

export type PredictionMetrics = {
  cols: number;
  rows: number;
  deviceCellWidth: number;
  deviceCellHeight: number;
  textTopGap: number;
  textBaselineY: number;
  glyphBoxHeight: number;
  dpr: number;
  font: string;
};

function sameCell(left: PredictionOverlayCell, right: PredictionOverlayCell): boolean {
  return (
    left.row === right.row &&
    left.col === right.col &&
    left.text === right.text &&
    left.wide === right.wide &&
    left.underline === right.underline
  );
}

export function samePredictionOverlay(
  left: PredictionOverlay | null,
  right: PredictionOverlay | null
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.cells.length !== right.cells.length) {
    return false;
  }
  const leftCursor = left.cursor;
  const rightCursor = right.cursor;
  if ((leftCursor === null) !== (rightCursor === null)) {
    return false;
  }
  if (
    leftCursor &&
    rightCursor &&
    (leftCursor.row !== rightCursor.row || leftCursor.col !== rightCursor.col)
  ) {
    return false;
  }
  for (let index = 0; index < left.cells.length; index += 1) {
    if (!sameCell(left.cells[index], right.cells[index])) {
      return false;
    }
  }
  return true;
}

function cellFitsGrid(cell: PredictionOverlayCell, metrics: PredictionMetrics): boolean {
  return (
    Number.isInteger(cell.row) &&
    Number.isInteger(cell.col) &&
    cell.row >= 0 &&
    cell.col >= 0 &&
    cell.row < metrics.rows &&
    cell.col + (cell.wide ? 2 : 1) <= metrics.cols
  );
}

function paletteKey(palette: PredictionPalette): string {
  return `${palette.background}|${palette.foreground}`;
}

// 预测层：独立 canvas（首个非空 overlay 到来时才由渲染器创建并 attach），位于 main/link 之上、
// selection/cursor 之下。overlay 的每个 cell 先用终端
// 默认底色盖住真实内容，再用默认前景色与主画布同一字体落字；它与主画布位图互不相干，
// 所以主画布按行重绘 / 滚动 blit 都不需要重画本层——只有 overlay 变化、位图被清空
// （resize / dpr）或配色变化时才动笔。
export class PredictionLayer {
  private overlay: PredictionOverlay | null = null;
  private metrics: PredictionMetrics | null = null;
  private drawnPaletteKey = '';
  private surface: LayerSurface | null = null;

  get attached(): boolean {
    return this.surface !== null;
  }

  attach(surface: LayerSurface): void {
    this.surface = surface;
  }

  get hasOverlay(): boolean {
    return this.overlay !== null;
  }

  setMetrics(metrics: PredictionMetrics): void {
    this.metrics = metrics;
  }

  // overlay 的深拷贝入库：宿主之后改动传入的数组 / 对象不会影响已落笔内容的比对。
  setOverlay(next: PredictionOverlay | null, palette: PredictionPalette | null): boolean {
    const normalized =
      next && (next.cells.length > 0 || next.cursor !== null)
        ? {
            cells: next.cells.map((cell) => ({ ...cell })),
            cursor: next.cursor ? { row: next.cursor.row, col: next.cursor.col } : null,
          }
        : null;
    if (samePredictionOverlay(this.overlay, normalized)) {
      return false;
    }

    this.overlay = normalized;
    this.draw(palette);
    return true;
  }

  // 位图已被外部清空（resize 换网格）时丢弃状态，不再多擦一遍。
  discard(): void {
    this.overlay = null;
    this.drawnPaletteKey = '';
  }

  clear(): boolean {
    return this.setOverlay(null, null);
  }

  // 每帧入口：位图被清空或配色变了才重画，常态帧零开销。
  sync(palette: PredictionPalette, wiped: boolean): void {
    if (!this.overlay) {
      return;
    }
    if (wiped || paletteKey(palette) !== this.drawnPaletteKey) {
      this.draw(palette);
    }
  }

  dispose(): void {
    this.discard();
    this.metrics = null;
    this.surface = null;
  }

  containsCell(cell: { row: number; col: number }): boolean {
    const { metrics } = this;
    return (
      Number.isInteger(cell.row) &&
      Number.isInteger(cell.col) &&
      cell.row >= 0 &&
      cell.col >= 0 &&
      (metrics === null || (cell.col < metrics.cols && cell.row < metrics.rows))
    );
  }

  private draw(palette: PredictionPalette | null): void {
    const { surface } = this;
    if (!surface) {
      return;
    }
    const { canvas, context } = surface;
    context.clearRect(0, 0, canvas.width, canvas.height);
    this.drawnPaletteKey = '';
    const overlay = this.overlay;
    const metrics = this.metrics;
    if (!overlay || !palette || !metrics) {
      return;
    }

    this.drawnPaletteKey = paletteKey(palette);
    context.font = metrics.font;
    context.textBaseline = 'alphabetic';
    for (const cell of overlay.cells) {
      if (cellFitsGrid(cell, metrics)) {
        this.drawCell(context, cell, palette, metrics);
      }
    }
  }

  private drawCell(
    context: CanvasRenderingContext2D,
    cell: PredictionOverlayCell,
    palette: PredictionPalette,
    metrics: PredictionMetrics
  ): void {
    const x = cell.col * metrics.deviceCellWidth;
    const y = cell.row * metrics.deviceCellHeight;
    const width = (cell.wide ? 2 : 1) * metrics.deviceCellWidth;
    context.fillStyle = palette.background;
    context.fillRect(x, y, width, metrics.deviceCellHeight);
    if (cell.text.trim() !== '') {
      context.fillStyle = palette.foreground;
      context.fillText(cell.text, x, y + metrics.textBaselineY);
    }
    if (cell.underline) {
      const thickness = Math.max(1, Math.round(metrics.dpr));
      const lineY = Math.min(
        Math.round(y + metrics.textTopGap + metrics.glyphBoxHeight - thickness),
        y + metrics.deviceCellHeight - thickness
      );
      context.fillStyle = palette.foreground;
      context.fillRect(x, lineY, width, thickness);
    }
  }
}
