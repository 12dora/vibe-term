// URL 是真相源：本 hook 把快照与路由对账（目标失效回落、window-only 路由补 pane、
// 空路由自动选中），并在路由身份就绪后下发 select / 轻量 FOCUS_PANE。

import type { TmuxWindow } from '@tmex/shared';
import { useTmuxStore } from '@tmex/stores/react';
import { useEffect, useRef } from 'react';
import { resolveSelectDispatch } from './pane-selection-rules';
import { resolveDeviceDefaultSelection, resolveRouteTarget } from './selection-recovery';
import type { PaneSelectionDispatch } from './use-pane-selection-dispatch';
import type { PaneSelectionRefs } from './use-pane-selection-state';

export function usePaneRouteReconciliation({
  deviceId,
  windowId,
  resolvedPaneId,
  windows,
  selectedWindow,
  deviceConnected,
  isLoading,
  isSplitView,
  isSelectionSettledMissing,
  refs,
  dispatch,
}: {
  deviceId?: string;
  windowId?: string;
  resolvedPaneId?: string;
  windows?: readonly TmuxWindow[];
  selectedWindow?: TmuxWindow;
  deviceConnected: boolean;
  isLoading: boolean;
  isSplitView: boolean;
  isSelectionSettledMissing: boolean;
  refs: PaneSelectionRefs;
  dispatch: PaneSelectionDispatch;
}): void {
  const focusPane = useTmuxStore((state) => state.focusPane);
  const selectPane = useTmuxStore((state) => state.selectPane);

  const { autoSelectedRef, lastDispatchedSelectRef, lastFullSelectWindowRef } = refs;
  const { getSelectSize, navigateToDeviceList, navigateToPane, recordSelectRequest } = dispatch;

  // 外部变更与侧边栏导航共用：路由点名的 window/pane 与快照对账
  useEffect(() => {
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windowId) return;
    // 快照尚未到达时不导航（loading 态）
    if (!windows) return;

    const action = resolveRouteTarget({
      windows,
      routeWindowId: windowId,
      routePaneId: resolvedPaneId,
      settledMissing: isSelectionSettledMissing,
    });
    if (action.kind === 'leave-device') {
      navigateToDeviceList();
      return;
    }
    if (action.kind === 'navigate') {
      navigateToPane(deviceId, action.windowId, action.paneId);
    }
  }, [
    deviceId,
    deviceConnected,
    isSelectionSettledMissing,
    windows,
    windowId,
    resolvedPaneId,
    navigateToDeviceList,
    navigateToPane,
  ]);

  // 仅首次进入设备时自动选中
  useEffect(() => {
    if (!deviceId) return;
    if (!deviceConnected) return;
    if (!windows || windows.length === 0) return;
    // window-only 路由由上面的对账 effect 处理
    if (windowId) return;
    if (autoSelectedRef.current) return;

    const target = resolveDeviceDefaultSelection({ windows });
    if (!target) return;

    autoSelectedRef.current = true;
    navigateToPane(deviceId, target.windowId, target.paneId);
  }, [autoSelectedRef, deviceConnected, deviceId, navigateToPane, windowId, windows]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 路由身份变化必须重置仅由 ref 持有的派发守卫
  useEffect(() => {
    lastDispatchedSelectRef.current = null;
  }, [deviceId, resolvedPaneId, lastDispatchedSelectRef]);

  // isSplitView 翻转会重建 Terminal 实例（单 Terminal ↔ SplitTerminalArea），
  // 焦点 pane 的新实例需要完整 select 重新拉 history，否则空白
  const prevSplitViewRef = useRef(isSplitView);
  useEffect(() => {
    if (prevSplitViewRef.current === isSplitView) return;
    prevSplitViewRef.current = isSplitView;
    lastDispatchedSelectRef.current = null;
    lastFullSelectWindowRef.current = null;
  }, [isSplitView, lastDispatchedSelectRef, lastFullSelectWindowRef]);

  useEffect(() => {
    if (!deviceId || !windowId || !resolvedPaneId) return;
    // WS READY 之前也允许下发 TMUX_SELECT：borsh client 会排队并在 READY 后 flush。
    // 这里不看 isSelectionInvalid——用户从 URL 进入时快照可能还没反映新 window，
    // select 仍需下发。
    if (isLoading || !deviceConnected) return;

    const action = resolveSelectDispatch({
      deviceId,
      windowId,
      paneId: resolvedPaneId,
      lastDispatchedKey: lastDispatchedSelectRef.current,
      isSplitView,
      lastFullSelectWindowKey: lastFullSelectWindowRef.current,
      selectedWindowPaneIds: selectedWindow?.panes.map((pane) => pane.id),
    });
    if (action.kind === 'skip') return;

    lastDispatchedSelectRef.current = action.dispatchKey;
    recordSelectRequest(windowId, resolvedPaneId);

    if (action.kind === 'focus') {
      focusPane(deviceId, windowId, resolvedPaneId);
      return;
    }

    selectPane(deviceId, windowId, resolvedPaneId, getSelectSize(windowId, resolvedPaneId));
    lastFullSelectWindowRef.current = action.fullSelectWindowKey;
  }, [
    deviceConnected,
    deviceId,
    focusPane,
    getSelectSize,
    isLoading,
    isSplitView,
    lastDispatchedSelectRef,
    lastFullSelectWindowRef,
    recordSelectRequest,
    resolvedPaneId,
    selectPane,
    selectedWindow,
    windowId,
  ]);
}
