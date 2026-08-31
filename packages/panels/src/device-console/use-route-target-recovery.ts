// 路由与快照的对账：URL 点名的 window/pane 失效时回落，以及首次进设备的自动选中。
// 与 select 派发拆开——这两件事只改路由，不下发任何 tmux 命令。

import type { TmuxWindow } from '@tmex/shared';
import { useEffect } from 'react';
import { resolveDeviceDefaultSelection, resolveRouteTarget } from './selection-recovery';
import type { PaneSelectionDispatch } from './use-pane-selection-dispatch';
import type { PaneSelectionRefs } from './use-pane-selection-state';

export function useRouteTargetRecovery({
  deviceId,
  windowId,
  resolvedPaneId,
  windows,
  deviceConnected,
  isSelectionSettledMissing,
  refs,
  dispatch,
}: {
  deviceId?: string;
  windowId?: string;
  resolvedPaneId?: string;
  windows?: readonly TmuxWindow[];
  deviceConnected: boolean;
  isSelectionSettledMissing: boolean;
  refs: PaneSelectionRefs;
  dispatch: PaneSelectionDispatch;
}): void {
  const { autoSelectedRef } = refs;
  const { navigateToDeviceList, navigateToPane } = dispatch;

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
}
