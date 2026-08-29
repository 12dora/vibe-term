import type { GhosttyCursorVisualStyle } from './types';

type CursorPaintContext = Pick<
  CanvasRenderingContext2D,
  'fillRect' | 'strokeRect' | 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'globalAlpha'
>;

type CursorCell = {
  x: number;
  y: number;
  style: GhosttyCursorVisualStyle;
  blinking: boolean;
};

type CursorShapeGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  thickness: number;
  lineThickness: number;
};

type CursorGeometryInput = {
  column: number;
  row: number;
  wideTail: boolean;
  deviceCellWidth: number;
  deviceCellHeight: number;
  dpr: number;
};

type CursorShapePainter = (context: CursorPaintContext, geometry: CursorShapeGeometry) => void;

const CURSOR_ALPHA = 0.7;

const CURSOR_SHAPE_PAINTERS: Record<GhosttyCursorVisualStyle, CursorShapePainter> = {
  bar: (context, geometry) => {
    context.fillRect(geometry.x, geometry.y, geometry.lineThickness, geometry.height);
  },
  underline: (context, geometry) => {
    context.fillRect(
      geometry.x,
      geometry.y + geometry.height - geometry.lineThickness,
      Math.max(geometry.width - geometry.thickness, geometry.thickness),
      geometry.lineThickness
    );
  },
  // 描边沿 cell 内缘走：奇数线宽偏移半物理像素，避免 1px 边框被抗锯齿糊成 2px。
  'block-hollow': (context, geometry) => {
    context.lineWidth = geometry.thickness;
    context.strokeRect(
      geometry.x + geometry.thickness / 2,
      geometry.y + geometry.thickness / 2,
      Math.max(geometry.width - geometry.thickness, geometry.thickness),
      Math.max(geometry.height - geometry.thickness, geometry.thickness)
    );
  },
  block: (context, geometry) => {
    context.fillRect(geometry.x, geometry.y, geometry.width, geometry.height);
  },
};

export function cursorShapeGeometry(input: CursorGeometryInput): CursorShapeGeometry {
  const thickness = Math.max(1, Math.round(input.dpr));
  return {
    x: input.column * input.deviceCellWidth,
    y: input.row * input.deviceCellHeight,
    width: input.wideTail ? input.deviceCellWidth * 2 : input.deviceCellWidth,
    height: input.deviceCellHeight,
    thickness,
    lineThickness: 2 * thickness,
  };
}

export function drawCursorShape(
  context: CursorPaintContext,
  shape: GhosttyCursorVisualStyle,
  geometry: CursorShapeGeometry,
  color: string
): void {
  context.fillStyle = color;
  context.strokeStyle = color;
  context.globalAlpha = CURSOR_ALPHA;
  (CURSOR_SHAPE_PAINTERS[shape] ?? CURSOR_SHAPE_PAINTERS.block)(context, geometry);
  context.globalAlpha = 1;
}

// 光标移动/换形/闪烁状态变化时，旧行需要重画一遍以擦除残影。
export function invalidatedCursorRow(previous: CursorCell | null, next: CursorCell): number | null {
  if (!previous) {
    return null;
  }

  const unchanged =
    previous.x === next.x &&
    previous.y === next.y &&
    previous.style === next.style &&
    previous.blinking === next.blinking;
  return unchanged ? null : previous.y;
}

export type { CursorCell, CursorPaintContext, CursorShapeGeometry };
