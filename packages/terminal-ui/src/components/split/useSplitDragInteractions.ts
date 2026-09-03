// 分屏的两类拖拽：splitter（改尺寸）与标题栏（重排 / 跨窗口移动 / 拆窗口）。
// 命中判定全部走 dragHitTesting 的纯函数，这里只负责事件接线与提交。
// pointermove 一律经 dragScheduling 的 rAF 调度器合并；rect 量测在 pointerdown 缓存一次。

import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import { type RefObject, useCallback, useState } from 'react';
import type { SplitGutter, SplitLayoutGeometry } from '../splitLayoutGeometry';
import { PANE_DRAG_THRESHOLD_PX } from './constants';
import {
  hasPassedDragThreshold,
  hitTestPaneDrop,
  resolveGutterResizeTarget,
  resolveSidebarDropTarget,
} from './dragHitTesting';
import {
  collectSidebarCandidates,
  createDragFrameScheduler,
  createDragMeasurement,
  toRectLike,
} from './dragScheduling';
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

interface GutterDragDeps {
  container: HTMLElement;
  gutterIndex: number;
  gutter: SplitGutter;
  event: React.PointerEvent<HTMLDivElement>;
  setDragState: (state: DragState | null) => void;
  getCellSize: () => { width: number; height: number } | null;
  reportWindowSize: () => boolean;
  commitResize: (paneId: string, size: { cols?: number; rows?: number }) => void;
}

// splitter 拖拽：pointermove 只更新参考线（rAF 合并），pointerup 提交 resize-pane 绝对值
function beginGutterDrag(deps: GutterDragDeps): void {
  const { container, gutterIndex, gutter, event } = deps;
  event.preventDefault();

  const startX = event.clientX;
  const startY = event.clientY;
  const target = event.currentTarget;
  target.setPointerCapture(event.pointerId);
  const scheduler = createDragFrameScheduler();
  deps.setDragState({ gutterIndex, deltaPx: 0 });

  const onMove = (moveEvent: PointerEvent) => {
    const deltaPx = gutter.axis === 'x' ? moveEvent.clientX - startX : moveEvent.clientY - startY;
    scheduler.schedule(() => deps.setDragState({ gutterIndex, deltaPx }));
  };

  const finish = (upEvent: PointerEvent, commit: boolean) => {
    target.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    scheduler.cancel();
    deps.setDragState(null);
    if (!commit) return;

    const cell = deps.getCellSize();
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
    deps.reportWindowSize();
    deps.commitResize(
      gutter.edgeLeafPaneId,
      gutter.axis === 'x' ? { cols: targetSize } : { rows: targetSize }
    );
  };

  const onUp = (upEvent: PointerEvent) => finish(upEvent, true);
  const onCancel = (cancelEvent: PointerEvent) => finish(cancelEvent, false);

  target.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}

interface TitleBarDragDeps {
  container: HTMLElement;
  geometry: SplitLayoutGeometry;
  srcPaneId: string;
  windowId: string;
  rootCols: number;
  rootRows: number;
  event: React.PointerEvent<HTMLDivElement>;
  setPaneDrag: (state: PaneDragState | null) => void;
  commitDrop: (target: PaneDragTarget) => void;
}

// 标题栏拖拽重排：命中测试基于 layout 比例几何（与渲染同源），
// 目标 pane 内距最近边的四分区决定 move-pane 的方向
function beginTitleBarDrag(deps: TitleBarDragDeps): void {
  const { container, geometry, srcPaneId, event } = deps;
  event.preventDefault();

  const startX = event.clientX;
  const startY = event.clientY;
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  let activated = false;

  const scheduler = createDragFrameScheduler();
  // 浮动标签每帧改 left/top，rect 若每次 move 现读就是每帧两次强制同步布局，
  // 布局范围含整棵已展开侧栏。拖拽期间只有滚动/改窗口能让它们失效。
  const containerRect = createDragMeasurement(() => toRectLike(container.getBoundingClientRect()));
  const sidebarCandidates = createDragMeasurement(collectSidebarCandidates);
  const invalidate = () => {
    containerRect.invalidate();
    sidebarCandidates.invalidate();
  };

  const resolveTarget = (clientX: number, clientY: number): PaneDragTarget | null => {
    const point = { x: clientX, y: clientY };
    const paneHit = hitTestPaneDrop(
      geometry.panes,
      point,
      containerRect.read(),
      deps.rootCols,
      deps.rootRows
    );
    if (paneHit) {
      return paneHit.paneId === srcPaneId ? null : { type: 'pane', ...paneHit };
    }
    return resolveSidebarDropTarget(sidebarCandidates.read(), point, deps.windowId);
  };

  const onMove = (moveEvent: PointerEvent) => {
    const pointerX = moveEvent.clientX;
    const pointerY = moveEvent.clientY;
    if (
      !activated &&
      !hasPassedDragThreshold(
        { x: startX, y: startY },
        { x: pointerX, y: pointerY },
        PANE_DRAG_THRESHOLD_PX
      )
    ) {
      return;
    }
    activated = true;
    scheduler.schedule(() => {
      deps.setPaneDrag({
        srcPaneId,
        active: true,
        pointerX,
        pointerY,
        target: resolveTarget(pointerX, pointerY),
      });
    });
  };

  const finish = (upEvent: PointerEvent, commit: boolean) => {
    handle.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('scroll', invalidate, true);
    window.removeEventListener('resize', invalidate);
    scheduler.cancel();
    deps.setPaneDrag(null);
    if (!commit || !activated) return;
    const target = resolveTarget(upEvent.clientX, upEvent.clientY);
    if (target) deps.commitDrop(target);
  };

  const onUp = (upEvent: PointerEvent) => finish(upEvent, true);
  const onCancel = (cancelEvent: PointerEvent) => finish(cancelEvent, false);

  handle.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('scroll', invalidate, true);
  window.addEventListener('resize', invalidate);
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

  const handleGutterPointerDown = useCallback(
    (gutterIndex: number, gutter: SplitGutter, event: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      beginGutterDrag({
        container,
        gutterIndex,
        gutter,
        event,
        setDragState,
        getCellSize,
        reportWindowSize,
        commitResize: (paneId, size) => resizePaneInWindow(deviceId, paneId, size),
      });
    },
    [containerRef, deviceId, getCellSize, reportWindowSize, resizePaneInWindow]
  );

  // 移入目标窗口：挂到其 active pane 右侧（tmux move-pane 支持跨窗口目标）
  const commitWindowDrop = useCallback(
    (srcPaneId: string, dstWindowId: string) => {
      const windows = runtime.stores.tmux.getState().snapshots[deviceId]?.session?.windows;
      const dstWindow = windows?.find((w) => w.id === dstWindowId);
      const dstPane = dstWindow?.panes.find((p) => p.active) ?? dstWindow?.panes[0];
      if (dstPane) movePane(deviceId, srcPaneId, dstPane.id, 'right');
    },
    [deviceId, movePane, runtime]
  );

  const handleTitleBarPointerDown = useCallback(
    (srcPaneId: string, event: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container || !geometry) return;
      beginTitleBarDrag({
        container,
        geometry,
        srcPaneId,
        windowId,
        rootCols,
        rootRows,
        event,
        setPaneDrag,
        commitDrop: (target) => {
          if (target.type === 'pane') {
            movePane(deviceId, srcPaneId, target.paneId, target.position);
            return;
          }
          if (target.type === 'window') {
            commitWindowDrop(srcPaneId, target.windowId);
            return;
          }
          breakPane(deviceId, srcPaneId);
        },
      });
    },
    [
      containerRef,
      deviceId,
      geometry,
      movePane,
      breakPane,
      commitWindowDrop,
      rootCols,
      rootRows,
      windowId,
    ]
  );

  return { dragState, paneDrag, handleGutterPointerDown, handleTitleBarPointerDown };
}
