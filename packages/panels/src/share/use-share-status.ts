// 某个 tab（deviceId + windowId）当前的分享状态：工具栏角标与弹窗共用同一份查询缓存。
// 有分享在跑时按 10 s 盯在线人数，没有时退到 60 s（切回页面还会各自触发一次）。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ShareListResponse, listShares, shareQueryKey } from '@tmex/api-client';
import type { ShareRecord } from '@tmex/shared/share';
import { useRuntime } from '@tmex/stores/react';
import { useCallback } from 'react';
import { pickActiveShare, shareRefetchIntervalMs } from './share-dialog-model';

export interface ShareStatusModel {
  activeShare: ShareRecord | null;
  viewers: number;
  isLoading: boolean;
  isError: boolean;
  /** 列表最近一次成功落地的时刻（epoch 毫秒），从未成功为 0。 */
  dataUpdatedAt: number;
  refresh: () => void;
}

export function useShareStatus(
  deviceId: string | undefined,
  windowId: string | undefined,
  enabled: boolean
): ShareStatusModel {
  const { apiClient } = useRuntime();
  const queryClient = useQueryClient();
  const filter = { deviceId, windowId };

  const query = useQuery({
    queryKey: shareQueryKey(filter),
    queryFn: ({ signal }) => listShares(apiClient, filter, signal),
    enabled: Boolean(enabled && deviceId && windowId),
    throwOnError: false,
    refetchInterval: (activeQuery) => {
      const data = activeQuery.state.data as ShareListResponse | undefined;
      return shareRefetchIntervalMs(pickActiveShare(data?.active, deviceId, windowId) !== null);
    },
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['share'] });
  }, [queryClient]);

  const activeShare = pickActiveShare(query.data?.active, deviceId, windowId);

  return {
    activeShare,
    viewers: activeShare?.viewers ?? 0,
    isLoading: query.isLoading,
    isError: query.isError && query.data === undefined,
    dataUpdatedAt: query.dataUpdatedAt,
    refresh,
  };
}
