// 设备树的按设备切片选择器：每行只订阅自己那台设备的快照与连接态，
// 避免整棵树跟着 snapshots 这张大表在每次 metadata patch 上重渲染。
// 返回值要么是原始值，要么是 store 里原样透出的引用，故无需额外的相等性比较。

import type { StateSnapshotPayload, TmuxWindow } from '@tmex/shared';
import { isSidebarDeviceVisible } from '@tmex/stores';
import { useTmuxStore } from '@tmex/stores/react';
import { useCallback } from 'react';

export interface DeviceSnapshotSlice {
  snapshots: Record<string, StateSnapshotPayload | undefined>;
}

export interface DeviceConnectivitySlice {
  deviceConnected: Record<string, boolean | undefined>;
  deviceErrors: Record<string, unknown>;
  deviceReconnecting: Record<string, unknown>;
}

function ownValue<T>(map: Record<string, T | undefined>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** 单台设备的窗口列表；引用只随该设备的快照变化，别的设备打补丁不会动它 */
export function selectDeviceWindows(
  state: DeviceSnapshotSlice,
  deviceId: string
): TmuxWindow[] | null {
  return ownValue(state.snapshots, deviceId)?.session?.windows ?? null;
}

/** 宿主未接管连接时的在线判定：已连接、无错误、且不在重连中 */
export function selectDeviceOnline(state: DeviceConnectivitySlice, deviceId: string): boolean {
  return (
    ownValue(state.deviceConnected, deviceId) === true &&
    !ownValue(state.deviceErrors, deviceId) &&
    !ownValue(state.deviceReconnecting, deviceId)
  );
}

export function useDeviceWindows(deviceId: string): TmuxWindow[] | null {
  return useTmuxStore(
    useCallback((state: DeviceSnapshotSlice) => selectDeviceWindows(state, deviceId), [deviceId])
  );
}

export function useDeviceOnline(deviceId: string): boolean {
  return useTmuxStore(
    useCallback((state: DeviceConnectivitySlice) => selectDeviceOnline(state, deviceId), [deviceId])
  );
}

/**
 * 侧边栏该展示哪些设备：远端 node 的设备默认隐藏，由「管理设备」逐台开启（可见性规则见
 * `@tmex/stores` 的 `isSidebarDeviceVisible`）。
 *
 * 当前路由选中的那台**无条件保留**：从「管理设备」点进一台未开启显示的远端设备后，
 * 侧边栏若把它一并滤掉，用户既看不到它、也没有窗口 / pane 树可点。
 */
export function selectSidebarVisibleDevices<T extends { id: string }>(
  devices: T[],
  visibility: Record<string, boolean>,
  runtimeNodeId: string,
  selectedDeviceId?: string
): T[] {
  return devices.filter(
    (device) =>
      device.id === selectedDeviceId || isSidebarDeviceVisible(visibility, runtimeNodeId, device.id)
  );
}
