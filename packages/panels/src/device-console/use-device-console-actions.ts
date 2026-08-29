// 控制台操作区的模型层：pane 归一/查找、可交互性、watch 查询与各操作回调。
// 包内构造的应用内路径经 hostAppPath 映射宿主路由形状。

import { useQuery } from '@tanstack/react-query';
import { fetchWatchRules, watchRulesQueryKey } from '@tmex/api-client';
import type { TmuxWindow } from '@tmex/shared';
import { decodePaneIdFromUrlParam, hostAppPath } from '@tmex/stores';
import { useRuntime, useTmuxStore, useUIStore } from '@tmex/stores/react';
import { useIsMobile } from '@tmex/ui';
import { type Dispatch, type SetStateAction, useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  buildPaneRoutePath,
  canInteractWithPane,
  hasEnabledWatchRule,
  isWatchRulesQueryEnabled,
  resolveCurrentPane,
  resolveSelectedWindow,
  shouldShowPaneSwitcher,
} from './device-console-action-rules';

export interface DeviceConsoleActionsModel {
  deviceId?: string;
  resolvedPaneId?: string;
  selectedWindow?: TmuxWindow;
  isMobileViewport: boolean;
  showPaneSwitcher: boolean;
  canInteract: boolean;
  watchUi: boolean;
  hasEnabledWatchRule: boolean;
  inputMode: 'direct' | 'editor';
  showRefreshConfirm: boolean;
  setShowRefreshConfirm: Dispatch<SetStateAction<boolean>>;
  showWatchDialog: boolean;
  setShowWatchDialog: Dispatch<SetStateAction<boolean>>;
  showTerminalSettings: boolean;
  setShowTerminalSettings: Dispatch<SetStateAction<boolean>>;
  onSwitchPane: (targetPaneId: string) => void;
  onSplitPane: (direction: 'right' | 'down') => void;
  onToggleInputMode: () => void;
  onJumpToLatest: () => void;
  onRefreshClick: () => void;
  onConfirmRefresh: () => void;
}

export function useDeviceConsoleActions({
  deviceId,
  windowId,
  paneId,
}: {
  deviceId?: string;
  windowId?: string;
  paneId?: string;
}): DeviceConsoleActionsModel {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const isMobileViewport = useIsMobile();
  const resolvedPaneId = paneId ? decodePaneIdFromUrlParam(paneId) : undefined;
  const inputMode = useUIStore((state) => state.inputMode);
  const setInputMode = useUIStore((state) => state.setInputMode);
  const deviceConnected = useTmuxStore((state) =>
    deviceId ? (state.deviceConnected?.[deviceId] ?? false) : false
  );
  const snapshot = useTmuxStore((state) => (deviceId ? state.snapshots[deviceId] : undefined));
  const selectedWindow = useMemo(
    () => resolveSelectedWindow(windowId, snapshot?.session?.windows),
    [windowId, snapshot]
  );
  const currentPane = useMemo(
    () => resolveCurrentPane(resolvedPaneId, selectedWindow),
    [resolvedPaneId, selectedWindow]
  );

  const onSwitchPane = useCallback(
    (targetPaneId: string) => {
      if (!deviceId || !windowId) return;
      navigate(hostAppPath(runtime.host, buildPaneRoutePath(deviceId, windowId, targetPaneId)), {
        replace: true,
      });
    },
    [deviceId, windowId, navigate, runtime.host]
  );

  const onSplitPane = useCallback(
    (direction: 'right' | 'down') => {
      if (!deviceId || !resolvedPaneId) return;
      runtime.stores.tmux
        .getState()
        .splitPane(deviceId, resolvedPaneId, direction, currentPane?.currentPath);
    },
    [deviceId, resolvedPaneId, currentPane?.currentPath, runtime]
  );

  const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);
  const [showWatchDialog, setShowWatchDialog] = useState(false);
  const [showTerminalSettings, setShowTerminalSettings] = useState(false);

  const watchUi = runtime.features.watchUi;

  const watchRulesQuery = useQuery({
    queryKey: watchRulesQueryKey(deviceId ?? '', resolvedPaneId ?? ''),
    queryFn: () => fetchWatchRules(deviceId ?? '', resolvedPaneId ?? '', runtime.apiClient),
    enabled: isWatchRulesQueryEnabled(watchUi, deviceId, resolvedPaneId),
    throwOnError: false,
  });

  const onToggleInputMode = useCallback(() => {
    setInputMode(inputMode === 'direct' ? 'editor' : 'direct');
  }, [inputMode, setInputMode]);

  const onJumpToLatest = useCallback(() => {
    window.dispatchEvent(new CustomEvent('tmex:jump-to-latest'));
  }, []);

  const onRefreshClick = useCallback(() => {
    setShowRefreshConfirm(true);
  }, []);

  const onConfirmRefresh = useCallback(() => {
    void (async () => runtime.host.reload())().catch(() => {});
  }, [runtime.host]);

  return {
    deviceId,
    resolvedPaneId,
    selectedWindow,
    isMobileViewport,
    showPaneSwitcher: shouldShowPaneSwitcher(isMobileViewport, resolvedPaneId, selectedWindow),
    canInteract: canInteractWithPane(resolvedPaneId, deviceConnected),
    watchUi,
    hasEnabledWatchRule: hasEnabledWatchRule(watchRulesQuery.data),
    inputMode,
    showRefreshConfirm,
    setShowRefreshConfirm,
    showWatchDialog,
    setShowWatchDialog,
    showTerminalSettings,
    setShowTerminalSettings,
    onSwitchPane,
    onSplitPane,
    onToggleInputMode,
    onJumpToLatest,
    onRefreshClick,
    onConfirmRefresh,
  };
}
