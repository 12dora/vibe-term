// 聚合侧边栏的分节可见性数据源：某个 node 运行时下「共有几台设备 / 侧边栏实际会渲染几台」。
// 与 SideBarDeviceList 用同一个 query key 与 queryFn，命中同一份 react-query 缓存，不多发请求。

import { useQuery } from '@tanstack/react-query';
import { devicesQueryKey as defaultDevicesQueryKey, fetchDevices } from '@tmex/api-client';
import { useRuntime, useUIStore } from '@tmex/stores/react';
import { useMemo } from 'react';
import { useDeviceTreeSelection } from './device-tree-navigation';
import { type SidebarDeviceStats, selectSidebarVisibleDevices } from './device-tree-selectors';

export function useSidebarDeviceStats(devicesQueryKey?: readonly unknown[]): SidebarDeviceStats {
  const runtime = useRuntime();
  const sidebarDeviceVisibility = useUIStore((state) => state.sidebarDeviceVisibility);
  const { selectedDeviceId } = useDeviceTreeSelection();

  const devicesQuery = useQuery({
    queryKey: devicesQueryKey ?? defaultDevicesQueryKey,
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
  });
  const devices = devicesQuery.data?.devices;

  const { nodeId } = runtime;
  return useMemo(() => {
    const list = devices ?? [];
    return {
      total: list.length,
      visible: selectSidebarVisibleDevices(list, sidebarDeviceVisibility, nodeId, selectedDeviceId)
        .length,
    };
  }, [devices, sidebarDeviceVisibility, nodeId, selectedDeviceId]);
}
