// 控制台操作区的纯推导：pane 上下文查找、路由拼装、可交互性与 watch 查询开关。

import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import { encodePaneIdForUrl } from '@tmex/stores';

export function resolveSelectedWindow(
  windowId: string | undefined,
  windows: readonly TmuxWindow[] | undefined
): TmuxWindow | undefined {
  if (!windowId || !windows) return undefined;
  return windows.find((w) => w.id === windowId);
}

export function resolveCurrentPane(
  resolvedPaneId: string | undefined,
  selectedWindow: TmuxWindow | undefined
): TmuxPane | undefined {
  if (!resolvedPaneId || !selectedWindow) return undefined;
  return selectedWindow.panes.find((p) => p.id === resolvedPaneId);
}

export function buildPaneRoutePath(deviceId: string, windowId: string, targetPaneId: string) {
  return `/devices/${deviceId}/windows/${windowId}/panes/${encodePaneIdForUrl(targetPaneId)}`;
}

export function canInteractWithPane(
  resolvedPaneId: string | undefined,
  deviceConnected: boolean
): boolean {
  return Boolean(resolvedPaneId && deviceConnected);
}

export function isWatchRulesQueryEnabled(
  watchUi: boolean,
  deviceId: string | undefined,
  resolvedPaneId: string | undefined
): boolean {
  return Boolean(watchUi && deviceId && resolvedPaneId);
}

export function hasEnabledWatchRule(rules: readonly { enabled: boolean }[] | undefined): boolean {
  return (rules ?? []).some((rule) => rule.enabled);
}

export function shouldShowPaneSwitcher(
  isMobileViewport: boolean,
  resolvedPaneId: string | undefined,
  selectedWindow: TmuxWindow | undefined
): boolean {
  return Boolean(
    isMobileViewport && resolvedPaneId && selectedWindow && selectedWindow.panes.length > 1
  );
}
