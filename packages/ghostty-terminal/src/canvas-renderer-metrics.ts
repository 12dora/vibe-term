import type { GhosttyColorRgb, GhosttySelectionRect } from './types';

export type CanvasSurfaceMetrics = {
  cols: number;
  rows: number;
  dpr: number;
  deviceCellWidth: number;
  deviceCellHeight: number;
  canvasWidth: number;
  canvasHeight: number;
};

export function canvasSurfaceUnchanged(
  current: CanvasSurfaceMetrics,
  next: {
    cols: number;
    rows: number;
    dpr: number;
    deviceCellWidth: number;
    deviceCellHeight: number;
  }
): boolean {
  return (
    current.cols === next.cols &&
    current.rows === next.rows &&
    current.dpr === next.dpr &&
    current.deviceCellWidth === next.deviceCellWidth &&
    current.deviceCellHeight === next.deviceCellHeight &&
    current.canvasWidth === next.cols * next.deviceCellWidth &&
    current.canvasHeight === next.rows * next.deviceCellHeight
  );
}

export function measureMaxTextRun(
  measureWidth: (text: string) => number,
  cols: number,
  deviceCellWidth: number
): number {
  const advanceSampleLength = Math.max(1, Math.min(cols, 64));
  const measuredAdvance = measureWidth('x'.repeat(advanceSampleLength)) / advanceSampleLength;
  const residual = Math.abs(measuredAdvance - deviceCellWidth);
  return Number.isFinite(residual) && residual > Number.EPSILON
    ? Math.max(1, Math.min(cols, Math.floor(0.4 / residual)))
    : cols;
}

export function sameSelectionRects(
  left: readonly GhosttySelectionRect[],
  right: readonly GhosttySelectionRect[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a.row !== b.row || a.x !== b.x || a.width !== b.width) {
      return false;
    }
  }

  return true;
}

export function toDeviceCell(size: number, dpr: number): number {
  return Math.max(1, Math.round(size * dpr));
}

export function colorToCss(color: GhosttyColorRgb): string {
  return `rgb(${color.r} ${color.g} ${color.b})`;
}
