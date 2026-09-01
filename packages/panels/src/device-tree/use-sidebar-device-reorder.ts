// 侧栏设备重排：乐观改写 react-query 缓存 + 失败回滚。
// 拖拽只在可见设备之间发生，但网关按提交序列整体重写 sortOrder：
// 必须把结果合并回完整顺序再提交，否则隐藏设备的旧 sortOrder 会与新序号撞车。

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { reorderDevices } from '@tmex/api-client';
import type { Device } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { reorderDevicesOptimistically } from './device-reorder';
import { mergeReorderedVisibleIds } from './device-tree-selectors';

type DeviceListItem = Device & {
  lastError?: string | null;
  lastErrorType?: string | null;
};

export interface SidebarDeviceReorder {
  /** 提交中：拖拽期间禁用排序，避免与在途请求打架 */
  isPending: boolean;
  reorder: (nextIds: string[]) => void;
}

export function useSidebarDeviceReorder({
  queryKey,
  allSortedDeviceIds,
  sortedDeviceIds,
}: {
  queryKey: readonly unknown[];
  /** 含隐藏设备的完整顺序 */
  allSortedDeviceIds: readonly string[];
  /** 当前可见（可拖拽）的顺序 */
  sortedDeviceIds: readonly string[];
}): SidebarDeviceReorder {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (deviceIds: string[]) => reorderDevices(deviceIds, runtime.apiClient),
    onMutate: async (deviceIds: string[]) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<{ devices: DeviceListItem[] }>(queryKey);
      if (previous) {
        queryClient.setQueryData(queryKey, {
          devices: reorderDevicesOptimistically(previous.devices, deviceIds),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      toast.error(t('device.reorderFailed'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const mutate = mutation.mutate;
  const reorder = useCallback(
    (nextIds: string[]) =>
      mutate(mergeReorderedVisibleIds(allSortedDeviceIds, sortedDeviceIds, nextIds)),
    [mutate, allSortedDeviceIds, sortedDeviceIds]
  );

  return { isPending: mutation.isPending, reorder };
}
