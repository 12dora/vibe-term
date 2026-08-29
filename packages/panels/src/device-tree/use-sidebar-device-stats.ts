// 聚合侧边栏的分节可见性数据源：某个 node 运行时下「共有几台设备 / 侧边栏实际会渲染几台」。
// 与 SideBarDeviceList 用同一个 query key 与 queryFn，命中同一份 react-query 缓存，不多发请求。

import { useQuery } from '@tanstack/react-query';
import { devicesQueryKey as defaultDevicesQueryKey, fetchDevices } from '@tmex/api-client';
import { useRuntime, useUIStore } from '@tmex/stores/react';
import { useMemo } from 'react';
import { useDeviceTreeSelection } from './device-tree-navigation';
import { type SidebarDeviceStats, selectSidebarVisibleDevices } from './device-tree-selectors';

export interface SidebarDeviceStatsResult extends SidebarDeviceStats {
  /** 设备列表请求失败：此时不能按「零设备」隐藏分节，要把加载失败/重试 UI 留给设备树。 */
  failed: boolean;
}

export function useSidebarDeviceStats(
  devicesQueryKey?: readonly unknown[]
): SidebarDeviceStatsResult {
  const runtime = useRuntime();
  const sidebarDeviceVisibility = useUIStore((state) => state.sidebarDeviceVisibility);
  const { selectedDeviceId } = useDeviceTreeSelection();

  const devicesQuery = useQuery({
    queryKey: devicesQueryKey ?? defaultDevicesQueryKey,
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
  });
  const devices = devicesQuery.data?.devices;
  const failed = devicesQuery.isError;

  const { nodeId } = runtime;
  return useMemo(() => {
    const list = devices ?? [];
    return {
      total: list.length,
      visible: selectSidebarVisibleDevices(list, sidebarDeviceVisibility, nodeId, selectedDeviceId)
        .length,
      failed,
    };
  }, [devices, failed, sidebarDeviceVisibility, nodeId, selectedDeviceId]);
}
