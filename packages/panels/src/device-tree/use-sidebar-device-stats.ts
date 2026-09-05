// 聚合侧边栏的分节可见性数据源：某个 node 运行时下「共有几台设备 / 侧边栏实际会渲染几台」。
// 与 SideBarDeviceList 用同一个 query key 与 queryFn，命中同一份 react-query 缓存，不多发请求。

import { useQuery } from '@tanstack/react-query';
import {
  type DeviceWithRuntime,
  type DevicesResponse,
  devicesQueryKey as defaultDevicesQueryKey,
  fetchDevices,
} from '@tmex/api-client';
import type { Device } from '@tmex/shared';
import { useRuntime, useUIStore } from '@tmex/stores/react';
import { useMemo } from 'react';
import { useDeviceTreeSelection } from './device-tree-navigation';
import { type SidebarDeviceStats, selectSidebarVisibleDevices } from './device-tree-selectors';

export interface SidebarDeviceStatsResult extends SidebarDeviceStats {
  /** 设备列表请求失败：此时不能按「零设备」隐藏分节，要把加载失败/重试 UI 留给设备树。 */
  failed: boolean;
  /** 侧边栏实际会渲染的设备 id（分节退场时供宿主锁存） */
  visibleIds: string[];
  /** 当前这份统计所依据的设备列表（`pending` 时即占位数据） */
  devices: DeviceWithRuntime[];
}

/** 快照里没有运行时状态字段，补成「未知」即可参与可见性计算。 */
function toPlaceholderDevice(device: Device): DeviceWithRuntime {
  return {
    ...device,
    lastSeenAt: null,
    lastError: null,
    lastErrorType: null,
    tmuxAvailable: false,
  };
}

export interface UseSidebarDeviceStatsOptions {
  devicesQueryKey?: readonly unknown[];
  /**
   * 首帧占位设备（宿主从本地快照 / node inventory 读出）。请求还没落地时按它算可见性，
   * 分节头与设备行才不用等一整个 `/api/devices` 往返；`pending` 同时为 true，宿主据此
   * 渲染占位而不是真实设备树。
   */
  placeholderDevices?: Device[];
}

export function useSidebarDeviceStats(
  options: UseSidebarDeviceStatsOptions = {}
): SidebarDeviceStatsResult {
  const runtime = useRuntime();
  const sidebarDeviceVisibility = useUIStore((state) => state.sidebarDeviceVisibility);
  const { selectedDeviceId } = useDeviceTreeSelection();
  const { placeholderDevices } = options;

  const placeholderData = useMemo<DevicesResponse | undefined>(
    () =>
      placeholderDevices && placeholderDevices.length > 0
        ? { devices: placeholderDevices.map(toPlaceholderDevice) }
        : undefined,
    [placeholderDevices]
  );

  const devicesQuery = useQuery({
    queryKey: options.devicesQueryKey ?? defaultDevicesQueryKey,
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
    placeholderData,
  });
  const devices = devicesQuery.data?.devices;
  const failed = devicesQuery.isError;
  // 占位数据也算「还没落地」：真实列表回来之前分节不能按它做隐藏 / 连接决策。
  const pending = devicesQuery.isPending || devicesQuery.isPlaceholderData;

  const { nodeId } = runtime;
  return useMemo(() => {
    const list = devices ?? [];
    const visible = selectSidebarVisibleDevices(
      list,
      sidebarDeviceVisibility,
      nodeId,
      selectedDeviceId
    );
    return {
      total: list.length,
      visible: visible.length,
      pending,
      failed,
      visibleIds: visible.map((device) => device.id),
      devices: list,
    };
  }, [devices, failed, pending, sidebarDeviceVisibility, nodeId, selectedDeviceId]);
}
