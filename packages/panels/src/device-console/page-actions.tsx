// 控制台操作区：输入模式切换、分屏、跳到最新、分享、watch、终端设置、刷新页面。
// 路由参数由宿主显式传入；paneId 为路由段原值（React Router 已 decode 一次），包内做归一；
// 数据面在 useDeviceConsoleActions，本组件只负责组合视图。

import { useState } from 'react';
import { DeferredShareDialog, useShareDialogPreload } from '../share/deferred-share-dialog';
import { DeferredWatchDialog, useWatchDialogPreload } from '../watch/deferred-watch-dialog';
import {
  DeferredTerminalSettingsSheet,
  useTerminalSettingsPreload,
} from './deferred-terminal-settings-sheet';
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
  const [showShareDialog, setShowShareDialog] = useState(false);
  // 空闲预热终端设置 chunk：趁当前 index.html 还新鲜先拉下来，绕开发版后旧 chunk 404 的窗口
  useTerminalSettingsPreload();
  // 同理预热监视规则对话框，但只在按钮真的会渲染时预热——功能关掉还拉一遍就是白费流量
  const watchAvailable = Boolean(model.watchUi && model.deviceId && model.resolvedPaneId);
  useWatchDialogPreload(watchAvailable);
  const shareAvailable = Boolean(model.shareUi && model.deviceId && model.windowId);
  useShareDialogPreload(shareAvailable);

  return (
    <>
      <DeviceConsoleToolbar
        model={model}
        onOpenRefreshConfirm={() => setShowRefreshConfirm(true)}
        onOpenWatchDialog={() => setShowWatchDialog(true)}
        onOpenTerminalSettings={() => setShowTerminalSettings(true)}
        onOpenShareDialog={() => setShowShareDialog(true)}
      />

      <DeferredTerminalSettingsSheet
        open={showTerminalSettings}
        onOpenChange={setShowTerminalSettings}
      />

      {shareAvailable && model.deviceId && model.windowId && (
        <DeferredShareDialog
          open={showShareDialog}
          onOpenChange={setShowShareDialog}
          deviceId={model.deviceId}
          windowId={model.windowId}
          defaultName={model.selectedWindow?.name ?? model.windowId}
        />
      )}

      {watchAvailable && model.deviceId && model.resolvedPaneId && (
        <DeferredWatchDialog
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
