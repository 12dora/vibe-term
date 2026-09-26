// 拿到某 node 权威的目录列表后，清掉它名下残留的「文件」开关（见 pruneStaleSidebarFilesVisibility）。
// 设备管理页（每个在线 node 都拉目录）与文件侧栏已挂运行时的分节都会调；重复调用是空操作。

import { useUIStore } from '@vibeterm/stores/react';
import { useEffect } from 'react';
import { type FileRootsQuerySnapshot, authoritativeRootDeviceIds } from './root-visibility';

export function usePruneStaleFilesVisibility(
  runtimeNodeId: string,
  query: FileRootsQuerySnapshot,
  nodeOnline: boolean
): void {
  const prune = useUIStore((state) => state.pruneSidebarFilesVisibility);
  const { data, isSuccess, isPlaceholderData } = query;
  useEffect(() => {
    const deviceIds = authoritativeRootDeviceIds(
      { data, isSuccess, isPlaceholderData },
      nodeOnline
    );
    if (deviceIds) prune(runtimeNodeId, deviceIds);
  }, [data, isSuccess, isPlaceholderData, nodeOnline, runtimeNodeId, prune]);
}
