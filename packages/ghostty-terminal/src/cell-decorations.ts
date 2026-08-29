import type { GhosttyRenderCellStyle } from './types';

type DecorationPaintContext = Pick<CanvasRenderingContext2D, 'fillRect'>;

type CellDecorationGeometry = {
  x: number;
  y: number;
  cellWidth: number;
  cellHeight: number;
  lineThickness: number;
  textTopGap: number;
  glyphBoxHeight: number;
};

// 装饰线随真实字形盒走，而非 cell 边缘：下划线贴字底、上划线贴字顶、
// 删除线穿字形几何中线。fillStyle 由调用方设好。
export function drawCellDecorations(
  context: DecorationPaintContext,
  style: GhosttyRenderCellStyle,
  geometry: CellDecorationGeometry
): void {
  const { x, y, cellWidth, cellHeight, lineThickness, textTopGap, glyphBoxHeight } = geometry;
  const glyphTop = y + textTopGap;
  const glyphBottom = glyphTop + glyphBoxHeight;
  const lineWidth = Math.max(cellWidth - lineThickness, lineThickness);

  if (style.underline > 0) {
    context.fillRect(
      x,
      Math.min(Math.round(glyphBottom - lineThickness), y + cellHeight - lineThickness),
      lineWidth,
      lineThickness
    );
  }

  if (style.strikethrough) {
    context.fillRect(x, Math.round(glyphTop + glyphBoxHeight / 2), lineWidth, lineThickness);
  }

  if (style.overline) {
    context.fillRect(x, Math.max(y, Math.round(glyphTop)), lineWidth, lineThickness);
  }
}

export type { CellDecorationGeometry, DecorationPaintContext };
