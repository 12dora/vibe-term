// 分屏拖拽的命中判定（纯函数）：DOM 只负责取矩形，判定逻辑全部在这里。

import { type DropPosition, type SplitPaneRect, resolveDropPosition } from '../splitLayoutGeometry';
import type { PaneDragTarget, RectLike } from './types';

export interface PaneDropHit {
  paneId: string;
  position: DropPosition;
}

export function pointWithinRect(x: number, y: number, rect: RectLike): boolean {
  return (
    x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height
  );
}

// 指针位置 → 命中的 pane 及其四分区。几何单位是 layout cells，
// 容器矩形按比例换算（与渲染同源，避免读取每个 pane 的实际 DOM 尺寸）。
export function hitTestPaneDrop(
  panes: readonly SplitPaneRect[],
  point: { x: number; y: number },
  container: RectLike,
  rootCols: number,
  rootRows: number
): PaneDropHit | null {
  if (container.width < 1 || container.height < 1) return null;
  const cellX = ((point.x - container.left) / container.width) * Math.max(1, rootCols);
  const cellY = ((point.y - container.top) / container.height) * Math.max(1, rootRows);
  for (const pane of panes) {
    if (!pointWithinRect(cellX, cellY, pane.rect)) continue;
    const relX = (cellX - pane.rect.left) / Math.max(1e-6, pane.rect.width);
    const relY = (cellY - pane.rect.top) / Math.max(1e-6, pane.rect.height);
    return { paneId: pane.paneId, position: resolveDropPosition(relX, relY) };
  }
  return null;
}

export interface SidebarDropCandidates {
  /** 侧栏中的窗口行（按 DOM 顺序） */
  windows: ReadonlyArray<{ windowId: string; rect: RectLike }>;
  /** 侧栏容器本身（按 DOM 顺序） */
  sidebars: readonly RectLike[];
}

// 侧栏落点：命中窗口行 = 移入该窗口；命中侧栏其余区域 = 拆为独立窗口。
// 命中当前窗口自身的行视为无效落点（不再向下查侧栏容器）。
export function resolveSidebarDropTarget(
  candidates: SidebarDropCandidates,
  point: { x: number; y: number },
  currentWindowId: string
): PaneDragTarget | null {
  for (const row of candidates.windows) {
    if (row.rect.width < 1 || !pointWithinRect(point.x, point.y, row.rect)) continue;
    if (!row.windowId || row.windowId === currentWindowId) return null;
    return { type: 'window', windowId: row.windowId, rect: { ...row.rect } };
  }
  for (const sidebar of candidates.sidebars) {
    if (sidebar.width < 1 || !pointWithinRect(point.x, point.y, sidebar)) continue;
    return { type: 'break', rect: { ...sidebar } };
  }
  return null;
}

// 拖拽阈值：位移超过阈值才算真正开始拖拽（避免与点击聚焦冲突）
export function hasPassedDragThreshold(
  start: { x: number; y: number },
  point: { x: number; y: number },
  thresholdPx: number
): boolean {
  return Math.hypot(point.x - start.x, point.y - start.y) >= thresholdPx;
}

export interface GutterResizeInput {
  axis: 'x' | 'y';
  deltaPx: number;
  /** 焦点实例的 cell 尺寸（px） */
  cell: { width: number; height: number };
  /** resize 目标叶子当前的 DOM 尺寸（px） */
  edgePaneSize: { width: number; height: number };
}

// splitter 拖拽结算：像素位移 → resize-pane 的绝对 cell 数。
// 位移不足一个 cell、或目标尺寸小于 2 cells 时不提交。
export function resolveGutterResizeTarget(input: GutterResizeInput): number | null {
  const axisCell = input.axis === 'x' ? input.cell.width : input.cell.height;
  if (axisCell <= 0) return null;
  const deltaCells = Math.round(input.deltaPx / axisCell);
  if (deltaCells === 0) return null;
  const currentSize = Math.floor(
    (input.axis === 'x' ? input.edgePaneSize.width : input.edgePaneSize.height) / axisCell
  );
  const targetSize = currentSize + deltaCells;
  if (targetSize < 2) return null;
  return targetSize;
}
