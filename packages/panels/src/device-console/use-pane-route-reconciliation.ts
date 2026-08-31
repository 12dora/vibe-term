// URL 是真相源：本 hook 把快照与路由对账（目标失效回落、window-only 路由补 pane、
// 空路由自动选中），并在路由身份就绪后下发 select / 轻量 FOCUS_PANE。

import type { TmuxWindow } from '@tmex/shared';
import { useTmuxStore } from '@tmex/stores/react';
import { useEffect, useRef } from 'react';
import { resolveSelectDispatch } from './pane-selection-rules';
import { isWarmSelectTarget } from './terminal-keep-alive';
import type { PaneSelectionDispatch } from './use-pane-selection-dispatch';
import type { PaneSelectionRefs } from './use-pane-selection-state';
import { useRouteTargetRecovery } from './use-route-target-recovery';

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

  const { lastDispatchedSelectRef, lastFullSelectWindowRef } = refs;
  const { getSelectSize, recordSelectRequest } = dispatch;

  useRouteTargetRecovery({
    deviceId,
    windowId,
    resolvedPaneId,
    windows,
    deviceConnected,
    isSelectionSettledMissing,
    refs,
    dispatch,
  });

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

    // 目标已在保活池里（终端还挂着、订阅没断）：只切 tmux 焦点，不重放 history
    const warm = isWarmSelectTarget(deviceId, resolvedPaneId);
    selectPane(
      deviceId,
      windowId,
      resolvedPaneId,
      getSelectSize(windowId, resolvedPaneId),
      warm ? { warm: true } : undefined
    );
    if (!warm) {
      lastFullSelectWindowRef.current = action.fullSelectWindowKey;
    }
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
