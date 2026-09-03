import type { GhosttyRenderCellStyle } from './types';

/** drawBlockElement / drawCellDecorations 只需要这两个能力，便于单测与跨 canvas 复用。 */
export type BlockElementSurface = Pick<CanvasRenderingContext2D, 'fillRect'> & {
  globalAlpha: number;
};

// U+2596–U+259F quadrant 块的象限组合：UL=1、UR=2、LL=4、LR=8
const QUADRANT_FLAGS = new Map<number, number>([
  [0x2596, 0b0100],
  [0x2597, 0b1000],
  [0x2598, 0b0001],
  [0x2599, 0b1101],
  [0x259a, 0b1001],
  [0x259b, 0b0111],
  [0x259c, 0b1011],
  [0x259d, 0b0010],
  [0x259e, 0b0110],
  [0x259f, 0b1110],
]);

const SHADE_ALPHA = new Map<number, number>([
  [0x2591, 0.25],
  [0x2592, 0.5],
  [0x2593, 0.75],
]);

export function isBlockElement(codepoint: number): boolean {
  return codepoint >= 0x2580 && codepoint <= 0x259f;
}

// fillStyle 由调用方设好。分割点统一 round 到整数物理像素，相邻块元素的
// 拼接处既不留缝也不重叠。
export function drawBlockElement(
  context: BlockElementSurface,
  codepoint: number,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  const sx = (n: number) => Math.round((width * n) / 8);
  const sy = (n: number) => Math.round((height * n) / 8);
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    context.fillRect(x + x0, y + y0, x1 - x0, y1 - y0);
  };

  if (codepoint === 0x2580) {
    // ▀ 上半块
    fill(0, 0, width, sy(4));
    return;
  }
  if (codepoint >= 0x2581 && codepoint <= 0x2588) {
    // ▁..█ 自下而上 n/8
    fill(0, sy(8 - (codepoint - 0x2580)), width, height);
    return;
  }
  if (codepoint >= 0x2589 && codepoint <= 0x258f) {
    // ▉..▏ 自左起 n/8
    fill(0, 0, sx(0x2590 - codepoint), height);
    return;
  }
  if (codepoint === 0x2590) {
    // ▐ 右半块
    fill(sx(4), 0, width, height);
    return;
  }
  const shadeAlpha = SHADE_ALPHA.get(codepoint);
  if (shadeAlpha !== undefined) {
    // ░▒▓ 按前景色 alpha 混合
    const previousAlpha = context.globalAlpha;
    context.globalAlpha = previousAlpha * shadeAlpha;
    fill(0, 0, width, height);
    context.globalAlpha = previousAlpha;
    return;
  }
  if (codepoint === 0x2594) {
    // ▔ 上 1/8
    fill(0, 0, width, sy(1));
    return;
  }
  if (codepoint === 0x2595) {
    // ▕ 右 1/8
    fill(sx(7), 0, width, height);
    return;
  }
  const quadrants = QUADRANT_FLAGS.get(codepoint) ?? 0;
  const midX = sx(4);
  const midY = sy(4);
  if (quadrants & 0b0001) fill(0, 0, midX, midY);
  if (quadrants & 0b0010) fill(midX, 0, width, midY);
  if (quadrants & 0b0100) fill(0, midY, midX, height);
  if (quadrants & 0b1000) fill(midX, midY, width, height);
}

export type CellDecorationMetrics = {
  cellHeight: number;
  textTopGap: number;
  glyphBoxHeight: number;
  lineThickness: number;
};

// 装饰线随真实字形盒走，而非 cell 边缘：下划线贴字底、上划线贴字顶、
// 删除线穿字形几何中线。fillStyle 由调用方设好。
export function drawCellDecorations(
  context: Pick<CanvasRenderingContext2D, 'fillRect'>,
  style: GhosttyRenderCellStyle,
  x: number,
  y: number,
  cellWidth: number,
  metrics: CellDecorationMetrics
): void {
  const { cellHeight, textTopGap, glyphBoxHeight, lineThickness } = metrics;
  const lineWidth = Math.max(cellWidth - lineThickness, lineThickness);

  if (style.underline > 0) {
    const glyphBottom = y + textTopGap + glyphBoxHeight;
    context.fillRect(
      x,
      Math.min(Math.round(glyphBottom - lineThickness), y + cellHeight - lineThickness),
      lineWidth,
      lineThickness
    );
  }

  if (style.strikethrough) {
    context.fillRect(x, Math.round(y + textTopGap + glyphBoxHeight / 2), lineWidth, lineThickness);
  }

  if (style.overline) {
    context.fillRect(x, Math.max(y, Math.round(y + textTopGap)), lineWidth, lineThickness);
  }
}
