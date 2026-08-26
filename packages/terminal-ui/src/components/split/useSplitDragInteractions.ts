// 分屏的两类拖拽：splitter（改尺寸）与标题栏（重排 / 跨窗口移动 / 拆窗口）。
// 命中判定全部走 dragHitTesting 的纯函数，这里只负责事件接线与提交。

import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import { type RefObject, useCallback, useState } from 'react';
import type { SplitGutter, SplitLayoutGeometry } from '../splitLayoutGeometry';
import { PANE_DRAG_THRESHOLD_PX } from './constants';
import {
  type SidebarDropCandidates,
  hasPassedDragThreshold,
  hitTestPaneDrop,
  resolveGutterResizeTarget,
  resolveSidebarDropTarget,
} from './dragHitTesting';
import type { DragState, PaneDragState, PaneDragTarget } from './types';

export interface SplitDragInteractionsInput {
  containerRef: RefObject<HTMLElement | null>;
  deviceId: string;
  windowId: string;
  geometry: SplitLayoutGeometry | null;
  rootCols: number;
  rootRows: number;
  getCellSize: () => { width: number; height: number } | null;
  reportWindowSize: () => boolean;
}

export interface SplitDragInteractions {
  dragState: DragState | null;
  paneDrag: PaneDragState | null;
  handleGutterPointerDown: (
    gutterIndex: number,
    gutter: SplitGutter,
    event: React.PointerEvent<HTMLDivElement>
  ) => void;
  handleTitleBarPointerDown: (srcPaneId: string, event: React.PointerEvent<HTMLDivElement>) => void;
}

function toRectLike(rect: DOMRect) {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

// 侧栏落点候选：窗口行 + 侧栏容器（按 DOM 顺序），判定交给纯函数
function collectSidebarCandidates(): SidebarDropCandidates {
  const windows = Array.from(document.querySelectorAll('[data-testid^="window-item-"]')).map(
    (row) => ({
      windowId: (row.getAttribute('data-testid') ?? '').replace('window-item-', ''),
      rect: toRectLike(row.getBoundingClientRect()),
    })
  );
  const sidebars = Array.from(document.querySelectorAll('[data-slot="sidebar"]')).map((sidebar) =>
    toRectLike(sidebar.getBoundingClientRect())
  );
  return { windows, sidebars };
}

export function useSplitDragInteractions({
  containerRef,
  deviceId,
  windowId,
  geometry,
  rootCols,
  rootRows,
  getCellSize,
  reportWindowSize,
}: SplitDragInteractionsInput): SplitDragInteractions {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [paneDrag, setPaneDrag] = useState<PaneDragState | null>(null);

  const runtime = useRuntime();
  const resizePaneInWindow = useTmuxStore((state) => state.resizePaneInWindow);
  const movePane = useTmuxStore((state) => state.movePane);
  const breakPane = useTmuxStore((state) => state.breakPane);

  // splitter 拖拽：pointermove 只更新参考线，pointerup 提交 resize-pane 绝对值
  const handleGutterPointerDown = useCallback(
    (gutterIndex: number, gutter: SplitGutter, event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const startX = event.clientX;
      const startY = event.clientY;
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      setDragState({ gutterIndex, deltaPx: 0 });

      const onMove = (moveEvent: PointerEvent) => {
        const delta = gutter.axis === 'x' ? moveEvent.clientX - startX : moveEvent.clientY - startY;
        setDragState({ gutterIndex, deltaPx: delta });
      };

      const finish = (upEvent: PointerEvent, commit: boolean) => {
        target.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        setDragState(null);
        if (!commit) return;

        const cell = getCellSize();
        if (!cell) return;
        const edgePaneEl = container.querySelector<HTMLElement>(
          `[data-pane-id="${gutter.edgeLeafPaneId}"]`
        );
        if (!edgePaneEl) return;
        const edgePaneRect = edgePaneEl.getBoundingClientRect();
        const targetSize = resolveGutterResizeTarget({
          axis: gutter.axis,
          deltaPx: gutter.axis === 'x' ? upEvent.clientX - startX : upEvent.clientY - startY,
          cell,
          edgePaneSize: { width: edgePaneRect.width, height: edgePaneRect.height },
        });
        if (targetSize === null) return;
        reportWindowSize();
        resizePaneInWindow(
          deviceId,
          gutter.edgeLeafPaneId,
          gutter.axis === 'x' ? { cols: targetSize } : { rows: targetSize }
        );
      };

      const onUp = (upEvent: PointerEvent) => finish(upEvent, true);
      const onCancel = (cancelEvent: PointerEvent) => finish(cancelEvent, false);

      target.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    },
    [containerRef, deviceId, getCellSize, reportWindowSize, resizePaneInWindow]
  );

  // 标题栏拖拽重排：命中测试基于 layout 比例几何（与渲染同源），
  // 目标 pane 内距最近边的四分区决定 move-pane 的方向
  const handleTitleBarPointerDown = useCallback(
    (srcPaneId: string, event: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container || !geometry) return;
      event.preventDefault();

      const startX = event.clientX;
      const startY = event.clientY;
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      let activated = false;

      const resolveTarget = (clientX: number, clientY: number): PaneDragTarget | null => {
        const point = { x: clientX, y: clientY };
        const paneHit = hitTestPaneDrop(
          geometry.panes,
          point,
          toRectLike(container.getBoundingClientRect()),
          rootCols,
          rootRows
        );
        if (paneHit) {
          return paneHit.paneId === srcPaneId ? null : { type: 'pane', ...paneHit };
        }
        return resolveSidebarDropTarget(collectSidebarCandidates(), point, windowId);
      };

      const onMove = (moveEvent: PointerEvent) => {
        if (
          !activated &&
          !hasPassedDragThreshold(
            { x: startX, y: startY },
            { x: moveEvent.clientX, y: moveEvent.clientY },
            PANE_DRAG_THRESHOLD_PX
          )
        ) {
          return;
        }
        activated = true;
        setPaneDrag({
          srcPaneId,
          active: true,
          pointerX: moveEvent.clientX,
          pointerY: moveEvent.clientY,
          target: resolveTarget(moveEvent.clientX, moveEvent.clientY),
        });
      };

      const finish = (upEvent: PointerEvent, commit: boolean) => {
        handle.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        setPaneDrag(null);
        if (!commit || !activated) return;
        const target = resolveTarget(upEvent.clientX, upEvent.clientY);
        if (!target) return;
        if (target.type === 'pane') {
          movePane(deviceId, srcPaneId, target.paneId, target.position);
          return;
        }
        if (target.type === 'window') {
          // 移入目标窗口：挂到其 active pane 右侧（tmux move-pane 支持跨窗口目标）
          const windows = runtime.stores.tmux.getState().snapshots[deviceId]?.session?.windows;
          const dstWindow = windows?.find((w) => w.id === target.windowId);
          const dstPane = dstWindow?.panes.find((p) => p.active) ?? dstWindow?.panes[0];
          if (dstPane) {
            movePane(deviceId, srcPaneId, dstPane.id, 'right');
          }
          return;
        }
        breakPane(deviceId, srcPaneId);
      };

      const onUp = (upEvent: PointerEvent) => finish(upEvent, true);
      const onCancel = (cancelEvent: PointerEvent) => finish(cancelEvent, false);

      handle.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    },
    [containerRef, deviceId, geometry, movePane, breakPane, rootCols, rootRows, runtime, windowId]
  );

  return { dragState, paneDrag, handleGutterPointerDown, handleTitleBarPointerDown };
}
