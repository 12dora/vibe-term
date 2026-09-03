// 控制台的「当前对象」域：设备连接状态 + 快照里 URL 指向的窗口 / 窗格。
// 只做读取与派生，不写 store；下游（pane 选择、editor、渲染）都消费这里的结果。

import { useQuery } from '@tanstack/react-query';
import { type DeviceWithRuntime, fetchDevices } from '@tmex/api-client';
import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import { useMemo } from 'react';

function appendKeyPart(parts: string[], value: string | number | boolean | undefined): void {
  const text = value === undefined ? '' : String(value);
  parts.push(`${text.length}:${text}`);
}

export function consoleWindowsTopologyKey(
  windows: readonly TmuxWindow[] | undefined
): string | null {
  if (!windows) return null;
  const parts: string[] = [];
  appendKeyPart(parts, windows.length);
  for (const window of windows) {
    appendKeyPart(parts, window.id);
    appendKeyPart(parts, window.index);
    appendKeyPart(parts, window.active);
    appendKeyPart(parts, window.layout);
    appendKeyPart(parts, window.panes.length);
    for (const pane of window.panes) {
      appendKeyPart(parts, pane.id);
      appendKeyPart(parts, pane.windowId);
      appendKeyPart(parts, pane.index);
      appendKeyPart(parts, pane.active);
      appendKeyPart(parts, pane.width);
      appendKeyPart(parts, pane.height);
      appendKeyPart(parts, pane.left);
      appendKeyPart(parts, pane.top);
    }
  }
  return parts.join('');
}

export function consoleWindowPresentationKey(
  windows: readonly TmuxWindow[] | undefined,
  windowId: string | undefined
): string | null {
  const selectedWindow = windows?.find((window) => window.id === windowId);
  if (!selectedWindow) return null;
  const parts: string[] = [];
  appendKeyPart(parts, selectedWindow.id);
  appendKeyPart(parts, selectedWindow.name);
  appendKeyPart(parts, selectedWindow.customName);
  appendKeyPart(parts, selectedWindow.panes.length);
  for (const pane of selectedWindow.panes) {
    appendKeyPart(parts, pane.id);
    appendKeyPart(parts, pane.title);
    appendKeyPart(parts, pane.customName);
    appendKeyPart(parts, pane.currentCommand);
    appendKeyPart(parts, pane.currentPath);
  }
  return parts.join('');
}

export interface UseConsoleTargetsOptions {
  deviceId?: string;
  windowId?: string;
  /** 已归一的 pane id（非路由段原值） */
  resolvedPaneId?: string;
  devicesQueryKey: readonly unknown[];
}

export interface ConsoleTargets {
  windows?: readonly TmuxWindow[];
  currentDevice?: DeviceWithRuntime;
  selectedWindow?: TmuxWindow;
  selectedPane?: TmuxPane;
  deviceErrorMessage?: string;
  deviceConnected: boolean;
  isReconnecting: boolean;
}

export function useConsoleTargets({
  deviceId,
  windowId,
  resolvedPaneId,
  devicesQueryKey,
}: UseConsoleTargetsOptions): ConsoleTargets {
  const runtime = useRuntime();
  const windowsTopologyKey = useTmuxStore((state) =>
    consoleWindowsTopologyKey(deviceId ? state.snapshots[deviceId]?.session?.windows : undefined)
  );
  const selectedWindowPresentationKey = useTmuxStore((state) =>
    consoleWindowPresentationKey(
      deviceId ? state.snapshots[deviceId]?.session?.windows : undefined,
      windowId
    )
  );
  const deviceErrorMessage = useTmuxStore((state) =>
    deviceId ? state.deviceErrors?.[deviceId]?.message : undefined
  );
  const deviceConnected = useTmuxStore((state) =>
    deviceId ? (state.deviceConnected?.[deviceId] ?? false) : false
  );
  const deviceReconnecting = useTmuxStore((state) =>
    deviceId ? state.deviceReconnecting?.[deviceId] : undefined
  );

  const { data: devicesData } = useQuery({
    queryKey: devicesQueryKey,
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
  });

  const currentDevice = useMemo(() => {
    if (!deviceId) {
      return undefined;
    }
    return devicesData?.devices.find((device) => device.id === deviceId);
  }, [deviceId, devicesData?.devices]);

  const windows = useMemo(() => {
    if (!deviceId || windowsTopologyKey === null) return undefined;
    return runtime.stores.tmux.getState().snapshots[deviceId]?.session?.windows;
  }, [deviceId, runtime, windowsTopologyKey]);

  const selectedWindow = useMemo(() => {
    if (
      !deviceId ||
      !windowId ||
      windowsTopologyKey === null ||
      selectedWindowPresentationKey === null
    ) {
      return undefined;
    }
    return runtime.stores.tmux
      .getState()
      .snapshots[deviceId]?.session?.windows.find((window) => window.id === windowId);
  }, [deviceId, runtime, selectedWindowPresentationKey, windowId, windowsTopologyKey]);

  const selectedPane = useMemo(() => {
    if (!resolvedPaneId || !selectedWindow) return undefined;
    return selectedWindow.panes.find((pane) => pane.id === resolvedPaneId);
  }, [resolvedPaneId, selectedWindow]);

  return {
    windows,
    currentDevice,
    selectedWindow,
    selectedPane,
    deviceErrorMessage,
    deviceConnected,
    isReconnecting: Boolean(deviceReconnecting),
  };
}
