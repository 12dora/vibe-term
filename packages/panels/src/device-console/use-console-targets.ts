// 控制台的「当前对象」域：设备连接状态 + 快照里 URL 指向的窗口 / 窗格。
// 只做读取与派生，不写 store；下游（pane 选择、editor、渲染）都消费这里的结果。

import { useQuery } from '@tanstack/react-query';
import { type DeviceWithRuntime, fetchDevices } from '@tmex/api-client';
import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import { useMemo } from 'react';

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
  const snapshot = useTmuxStore((state) => (deviceId ? state.snapshots[deviceId] : undefined));
  const deviceErrorMessage = useTmuxStore((state) =>
    deviceId ? state.deviceErrors?.[deviceId]?.message : undefined
  );
  const deviceConnected = useTmuxStore((state) =>
    deviceId ? (state.deviceConnected?.[deviceId] ?? false) : false
  );
  const deviceReconnecting = useTmuxStore((state) =>
    deviceId ? state.deviceReconnecting?.[deviceId] : undefined
  );

  const runtime = useRuntime();
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

  const windows = snapshot?.session?.windows;

  const selectedWindow = useMemo(() => {
    if (!windowId || !windows) return undefined;
    return windows.find((win) => win.id === windowId);
  }, [windowId, windows]);

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
