// 控制台操作区：输入模式切换、分屏、跳到最新、watch、终端设置、刷新页面。
// 路由参数由宿主显式传入；paneId 为路由段原值（React Router 已 decode 一次），包内做归一；
// 数据面在 useDeviceConsoleActions，本组件只负责组合视图。

import { useState } from 'react';
import { WatchDialog } from '../watch/watch-dialog';
import { DeferredTerminalSettingsSheet } from './deferred-terminal-settings-sheet';
import { DeviceConsoleToolbar } from './device-console-toolbar';
import { RefreshConfirmDialog } from './refresh-confirm-dialog';
import { useDeviceConsoleActions } from './use-device-console-actions';

export interface DeviceConsoleActionsProps {
  deviceId?: string;
  windowId?: string;
  paneId?: string;
}

export function DeviceConsoleActions({ deviceId, windowId, paneId }: DeviceConsoleActionsProps) {
  const model = useDeviceConsoleActions({ deviceId, windowId, paneId });
  const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);
  const [showWatchDialog, setShowWatchDialog] = useState(false);
  const [showTerminalSettings, setShowTerminalSettings] = useState(false);

  return (
    <>
      <DeviceConsoleToolbar
        model={model}
        onOpenRefreshConfirm={() => setShowRefreshConfirm(true)}
        onOpenWatchDialog={() => setShowWatchDialog(true)}
        onOpenTerminalSettings={() => setShowTerminalSettings(true)}
      />

      <DeferredTerminalSettingsSheet
        open={showTerminalSettings}
        onOpenChange={setShowTerminalSettings}
      />

      {model.watchUi && model.deviceId && model.resolvedPaneId && (
        <WatchDialog
          open={showWatchDialog}
          onOpenChange={setShowWatchDialog}
          deviceId={model.deviceId}
          paneId={model.resolvedPaneId}
        />
      )}

      <RefreshConfirmDialog
        open={showRefreshConfirm}
        onOpenChange={setShowRefreshConfirm}
        onConfirm={model.onConfirmRefresh}
      />
    </>
  );
}
