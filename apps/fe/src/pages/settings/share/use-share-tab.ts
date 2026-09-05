// 「分享」标签的数据与写操作：列表（每 10 秒一拍）、设备名、地址候选、分享设置。
// 组件只读这里的投影，不自己发请求。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { devicesQueryKey, fetchDevices } from '@tmex/api-client';
import type { ShareRecord, ShareSettings } from '@tmex/shared/share';
import { useRuntime } from '@tmex/stores/react';
import { useCallback, useMemo, useState } from 'react';
import { SETTINGS_STALE_MS } from '../data-prefetch';
import {
  type ShareListResponse,
  type ShareOriginsResponse,
  deleteShare,
  fetchShareSettings,
  getShareOrigins,
  listShares,
  revokeShare,
  saveShareSettings,
  shareOriginsQueryKey,
  shareQueryKey,
  shareSettingsQueryKey,
} from './share-api';

/** 进行中的分享要看在线人数与剩余期限，一拍 10 秒；标签不在前台时 react-query 自动停。 */
export const SHARE_POLL_MS = 10_000;

const EMPTY_LIST: ShareListResponse = { active: [], history: [] };

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

export interface ShareTabModel {
  active: ShareRecord[];
  history: ShareRecord[];
  /** 相对时间的基准：随每一拍推进，中间不逐秒重渲染。 */
  now: number;
  loading: boolean;
  loadError: string | null;
  deviceName: (deviceId: string) => string | null;
  origins: ShareOriginsResponse | null;
  settings: ShareSettings | null;
  settingsError: string | null;
  /** 正在写入的分享 id：该行动作禁用。 */
  busyShareId: string | null;
  actionError: string | null;
  savingSettings: boolean;
  saveError: string | null;
  refresh: () => void;
  revoke: (record: ShareRecord) => void;
  remove: (record: ShareRecord) => void;
  saveSettings: (next: ShareSettings) => void;
}

export function useShareTab(): ShareTabModel {
  const { apiClient } = useRuntime();
  const queryClient = useQueryClient();
  const [busyShareId, setBusyShareId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: shareQueryKey(),
    queryFn: ({ signal }) => listShares(apiClient, {}, signal),
    refetchInterval: SHARE_POLL_MS,
  });

  const devicesQuery = useQuery({
    queryKey: devicesQueryKey,
    queryFn: ({ signal }) => fetchDevices(apiClient, { signal }),
    staleTime: SETTINGS_STALE_MS,
  });

  const originsQuery = useQuery({
    queryKey: shareOriginsQueryKey,
    queryFn: () => getShareOrigins(apiClient),
    staleTime: SETTINGS_STALE_MS,
  });

  const settingsQuery = useQuery({
    queryKey: shareSettingsQueryKey,
    queryFn: ({ signal }) => fetchShareSettings(apiClient, signal),
    staleTime: SETTINGS_STALE_MS,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: shareQueryKey() });
  }, [queryClient]);

  const runAction = useCallback(
    async (record: ShareRecord, action: () => Promise<unknown>) => {
      setBusyShareId(record.id);
      setActionError(null);
      try {
        await action();
        await queryClient.invalidateQueries({ queryKey: shareQueryKey() });
      } catch (error) {
        setActionError(errorText(error));
      } finally {
        setBusyShareId(null);
      }
    },
    [queryClient]
  );

  const settingsMutation = useMutation({
    mutationFn: (next: ShareSettings) => saveShareSettings(apiClient, next),
    onSuccess: (saved) => {
      queryClient.setQueryData(shareSettingsQueryKey, saved);
    },
  });

  const deviceNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const device of devicesQuery.data?.devices ?? []) map.set(device.id, device.name);
    return map;
  }, [devicesQuery.data]);

  const list = listQuery.data ?? EMPTY_LIST;
  return {
    active: list.active,
    history: list.history,
    now: listQuery.dataUpdatedAt || Date.now(),
    loading: listQuery.isPending,
    loadError: errorText(listQuery.error),
    deviceName: (deviceId: string) => deviceNames.get(deviceId) ?? null,
    origins: originsQuery.data ?? null,
    settings: settingsQuery.data ?? null,
    settingsError: errorText(settingsQuery.error),
    busyShareId,
    actionError,
    savingSettings: settingsMutation.isPending,
    saveError: errorText(settingsMutation.error),
    refresh,
    revoke: (record) => void runAction(record, () => revokeShare(apiClient, record.id)),
    remove: (record) => void runAction(record, () => deleteShare(apiClient, record.id)),
    saveSettings: (next) => settingsMutation.mutate(next),
  };
}
