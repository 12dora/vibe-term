// 控制台标题：当前 window/pane 的终端标签（带响铃指示）。
// 路由参数由宿主显式传入；paneId 为路由段原值（React Router 已 decode 一次），包内做归一。

import { useBellStore } from '@tmex/notifications';
import { PRODUCT_NAME } from '@tmex/shared';
import { buildTerminalLabel, decodePaneIdFromUrlParam } from '@tmex/stores';
import { useSiteStore, useTmuxStore } from '@tmex/stores/react';
import { useMemo } from 'react';

export interface DeviceConsolePageTitleProps {
  deviceId?: string;
  windowId?: string;
  paneId?: string;
}

export function DeviceConsolePageTitle({
  deviceId,
  windowId,
  paneId,
}: DeviceConsolePageTitleProps) {
  const resolvedPaneId = paneId ? decodePaneIdFromUrlParam(paneId) : undefined;
  const snapshots = useTmuxStore((state) => state.snapshots);
  const siteName = useSiteStore((state) => state.settings?.siteName ?? PRODUCT_NAME);

  const snapshot = deviceId ? snapshots[deviceId] : undefined;
  const selectedWindow = useMemo(() => {
    if (!windowId || !snapshot?.session?.windows) return undefined;
    return snapshot.session.windows.find((w) => w.id === windowId);
  }, [windowId, snapshot]);

  const selectedPane = useMemo(() => {
    if (!resolvedPaneId || !selectedWindow) return undefined;
    return selectedWindow.panes.find((p) => p.id === resolvedPaneId);
  }, [resolvedPaneId, selectedWindow]);

  const title = useMemo(() => {
    if (selectedWindow && selectedPane) {
      return buildTerminalLabel({
        paneCustomName: selectedPane.customName,
        paneTitle: selectedPane.title,
        windowName: selectedWindow.name,
        windowCustomName: selectedWindow.customName,
        deviceName: siteName,
      });
    }
    return deviceId ?? '';
  }, [selectedWindow, selectedPane, siteName, deviceId]);

  const isRinging = useBellStore((state) =>
    resolvedPaneId ? Boolean(state.ringingPanes[resolvedPaneId]) : false
  );
  return (
    <>
      {isRinging && <span className="bell-blink">🔔 </span>}
      {title}
    </>
  );
}
