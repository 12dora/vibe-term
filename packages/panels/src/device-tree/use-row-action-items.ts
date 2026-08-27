import { useRuntime } from '@tmex/stores/react';
import { useTranslation } from 'react-i18next';
import type { DeviceActionItem } from './device-actions-menu';
import { buildPaneActions, buildWindowActions } from './device-tree-actions';
import type { PaneRowProps, WindowRowProps } from './device-tree-row-props';

export function useWindowActionItems({
  deviceId,
  tmuxWindow,
  selectedPaneId,
  onRenameWindow,
  onCloseWindow,
  onWatchPane,
  agent,
  nav,
}: WindowRowProps): DeviceActionItem[] {
  const { t } = useTranslation();
  const { stores, features } = useRuntime();
  const { panes, id: windowId } = tmuxWindow;
  // 零 pane 的窗口（快照到达前的中间态）没有可挂 agent 会话的目标，菜单项必须整条消失
  const sessionTargetPane = panes.find((pane) => pane.id === selectedPaneId) ?? panes[0];

  return buildWindowActions({
    t,
    tmuxWindow,
    watchUi: features.watchUi,
    onRename: () => onRenameWindow(deviceId, windowId),
    onCreateSession:
      agent && sessionTargetPane
        ? () => agent.onCreateSessionForPane(nav, deviceId, windowId, sessionTargetPane)
        : undefined,
    onCreateWindowInCwd: (cwd) => stores.tmux.getState().createWindow(deviceId, undefined, cwd),
    onSplit: (paneId, direction, cwd) =>
      stores.tmux.getState().splitPane(deviceId, paneId, direction, cwd),
    onWatch: (paneId) => onWatchPane(deviceId, paneId),
    onClose: () => onCloseWindow(deviceId, windowId),
  });
}

export function usePaneActionItems({
  deviceId,
  windowId,
  pane,
  onClosePane,
  onRenamePane,
  onWatchPane,
  agent,
  nav,
}: PaneRowProps): DeviceActionItem[] {
  const { t } = useTranslation();
  const { stores, features } = useRuntime();

  return buildPaneActions({
    t,
    pane,
    watchUi: features.watchUi,
    onRename: () => onRenamePane(deviceId, pane.id),
    onCreateSession: agent
      ? () => agent.onCreateSessionForPane(nav, deviceId, windowId, pane)
      : undefined,
    onCreateWindowInCwd: (cwd) => stores.tmux.getState().createWindow(deviceId, undefined, cwd),
    onSplit: (paneId, direction, cwd) =>
      stores.tmux.getState().splitPane(deviceId, paneId, direction, cwd),
    onWatch: (paneId) => onWatchPane(deviceId, paneId),
    onClose: () => onClosePane(deviceId, windowId, pane.id),
  });
}
