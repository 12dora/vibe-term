// 控制台操作区的数据面：路由参数归一、快照选择、watch 规则查询与导航/终端动作。
// 视图层只消费这里返回的 model，不再直接读 store。

import { useQuery } from '@tanstack/react-query';
import { fetchWatchRules, watchRulesQueryKey } from '@tmex/api-client';
import type { StateSnapshotPayload, TmuxPane, TmuxWindow, WatchRuleDto } from '@tmex/shared';
import { decodePaneIdFromUrlParam, encodePaneIdForUrl, hostAppPath } from '@tmex/stores';
import { useRuntime, useTmuxStore, useUIStore } from '@tmex/stores/react';
import { useIsMobile } from '@tmex/ui';
import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router';

export type InputMode = 'direct' | 'editor';
export type SplitDirection = 'right' | 'down';

export interface DeviceConsoleActionsInput {
  deviceId?: string;
  windowId?: string;
  paneId?: string;
}

export interface ConsoleCommands {
  onSwitchPane: (targetPaneId: string) => void;
  onSplitPane: (direction: SplitDirection) => void;
  onJumpToLatest: () => void;
  onConfirmRefresh: () => void;
}

export interface DeviceConsoleActionsModel extends ConsoleCommands {
  deviceId?: string;
  resolvedPaneId?: string;
  selectedWindow?: TmuxWindow;
  isMobileViewport: boolean;
  inputMode: InputMode;
  canInteract: boolean;
  watchUi: boolean;
  hasEnabledWatchRule: boolean;
  onToggleInputMode: () => void;
}

export function findWindow(
  snapshot: StateSnapshotPayload | undefined,
  windowId?: string
): TmuxWindow | undefined {
  if (!windowId) return undefined;
  return snapshot?.session?.windows?.find((tmuxWindow) => tmuxWindow.id === windowId);
}

export function findPane(
  tmuxWindow: TmuxWindow | undefined,
  paneId?: string
): TmuxPane | undefined {
  if (!paneId) return undefined;
  return tmuxWindow?.panes.find((pane) => pane.id === paneId);
}

export function hasEnabledWatchRule(rules: readonly WatchRuleDto[] | undefined): boolean {
  return (rules ?? []).some((rule) => rule.enabled);
}

export function panePath(deviceId: string, windowId: string, paneId: string): string {
  return `/devices/${deviceId}/windows/${windowId}/panes/${encodePaneIdForUrl(paneId)}`;
}

export function nextInputMode(mode: InputMode): InputMode {
  return mode === 'direct' ? 'editor' : 'direct';
}

function useWatchRuleIndicator(
  deviceId: string | undefined,
  paneId: string | undefined,
  watchUi: boolean
): boolean {
  const runtime = useRuntime();
  const query = useQuery({
    queryKey: watchRulesQueryKey(deviceId ?? '', paneId ?? ''),
    queryFn: () => fetchWatchRules(deviceId ?? '', paneId ?? '', runtime.apiClient),
    enabled: Boolean(watchUi && deviceId && paneId),
    throwOnError: false,
  });
  return hasEnabledWatchRule(query.data);
}

function useConsoleCommands({
  deviceId,
  windowId,
  resolvedPaneId,
  currentPath,
}: {
  deviceId?: string;
  windowId?: string;
  resolvedPaneId?: string;
  currentPath?: string;
}): ConsoleCommands {
  const runtime = useRuntime();
  const navigate = useNavigate();

  const onSwitchPane = useCallback(
    (targetPaneId: string) => {
      if (!deviceId || !windowId) return;
      navigate(hostAppPath(runtime.host, panePath(deviceId, windowId, targetPaneId)), {
        replace: true,
      });
    },
    [deviceId, windowId, navigate, runtime.host]
  );

  const onSplitPane = useCallback(
    (direction: SplitDirection) => {
      if (!deviceId || !resolvedPaneId) return;
      runtime.stores.tmux.getState().splitPane(deviceId, resolvedPaneId, direction, currentPath);
    },
    [deviceId, resolvedPaneId, currentPath, runtime]
  );

  const onJumpToLatest = useCallback(() => {
    // detail 带 nodeId：将来多 node 面板并存时接收方可按 node 过滤（当前同一时刻只有一个控制台）
    window.dispatchEvent(
      new CustomEvent('tmex:jump-to-latest', { detail: { nodeId: runtime.nodeId } })
    );
  }, [runtime.nodeId]);

  const onConfirmRefresh = useCallback(() => {
    void (async () => runtime.host.reload())().catch(() => {});
  }, [runtime.host]);

  return { onSwitchPane, onSplitPane, onJumpToLatest, onConfirmRefresh };
}

export function useDeviceConsoleActions({
  deviceId,
  windowId,
  paneId,
}: DeviceConsoleActionsInput): DeviceConsoleActionsModel {
  const runtime = useRuntime();
  const isMobileViewport = useIsMobile();
  const resolvedPaneId = paneId ? decodePaneIdFromUrlParam(paneId) : undefined;
  const inputMode = useUIStore((state) => state.inputMode);
  const setInputMode = useUIStore((state) => state.setInputMode);
  const deviceConnected = useTmuxStore((state) =>
    deviceId ? (state.deviceConnected?.[deviceId] ?? false) : false
  );
  const snapshot = useTmuxStore((state) => (deviceId ? state.snapshots[deviceId] : undefined));

  const selectedWindow = useMemo(() => findWindow(snapshot, windowId), [snapshot, windowId]);
  const currentPane = useMemo(
    () => findPane(selectedWindow, resolvedPaneId),
    [selectedWindow, resolvedPaneId]
  );

  const commands = useConsoleCommands({
    deviceId,
    windowId,
    resolvedPaneId,
    currentPath: currentPane?.currentPath,
  });

  const onToggleInputMode = useCallback(() => {
    setInputMode(nextInputMode(inputMode));
  }, [inputMode, setInputMode]);

  const watchUi = runtime.features.watchUi;
  const hasWatchRule = useWatchRuleIndicator(deviceId, resolvedPaneId, watchUi);

  return {
    ...commands,
    deviceId,
    resolvedPaneId,
    selectedWindow,
    isMobileViewport,
    inputMode,
    canInteract: Boolean(resolvedPaneId && deviceConnected),
    watchUi,
    hasEnabledWatchRule: hasWatchRule,
    onToggleInputMode,
  };
}
