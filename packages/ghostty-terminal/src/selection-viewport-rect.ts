import type {
  GhosttyCellDimensions,
  GhosttySelectionRect,
  GhosttySelectionViewportRect,
} from './types';

export interface SelectionScreenOrigin {
  left: number;
  top: number;
}

/** 把视口相对的单元格选区矩形并成 client 坐标系包围盒；无可见矩形时 null。 */
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
    const rectLeft = screen.left + rect.x * cell.width;
    const rectTop = screen.top + rect.row * cell.height;
    left = Math.min(left, rectLeft);
    top = Math.min(top, rectTop);
    right = Math.max(right, rectLeft + rect.width * cell.width);
    bottom = Math.max(bottom, rectTop + cell.height);
  }

  if (!Number.isFinite(left) || right <= left || bottom <= top) {
    return null;
  }

  return { left, top, width: right - left, height: bottom - top };
}
