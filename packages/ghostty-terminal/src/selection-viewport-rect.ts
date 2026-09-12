import type {
  GhosttyCellDimensions,
  GhosttySelectionRect,
  GhosttySelectionViewportRect,
} from './types';

export interface SelectionScreenOrigin {
  left: number;
  top: number;
  /** 画布可见区右/下边（client 坐标）；给了就把每块矩形裁到可见区内。 */
  right?: number;
  bottom?: number;
}

/** 把视口相对的单元格选区矩形并成 client 坐标系包围盒，裁到画布可见区；无可见矩形时 null。 */
export function unionSelectionViewportRect(
  rects: readonly GhosttySelectionRect[],
  screen: SelectionScreenOrigin,
  cell: GhosttyCellDimensions
): GhosttySelectionViewportRect | null {
  if (rects.length === 0 || cell.width <= 0 || cell.height <= 0) {
    return null;
  }

  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const rect of rects) {
    if (rect.width <= 0) {
      continue;
    }
    const rectLeft = Math.max(screen.left + rect.x * cell.width, screen.left);
    const rectTop = Math.max(screen.top + rect.row * cell.height, screen.top);
    const rectRight = Math.min(
      screen.left + (rect.x + rect.width) * cell.width,
      screen.right ?? Number.POSITIVE_INFINITY
    );
    const rectBottom = Math.min(
      screen.top + (rect.row + 1) * cell.height,
      screen.bottom ?? Number.POSITIVE_INFINITY
    );
    if (rectRight <= rectLeft || rectBottom <= rectTop) {
      continue;
    }
    left = Math.min(left, rectLeft);
    top = Math.min(top, rectTop);
    right = Math.max(right, rectRight);
    bottom = Math.max(bottom, rectBottom);
  }

  if (!Number.isFinite(left) || right <= left || bottom <= top) {
    return null;
  }

  return { left, top, width: right - left, height: bottom - top };
}
