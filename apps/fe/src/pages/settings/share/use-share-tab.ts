// 「分享」标签的数据与写操作：列表（每 10 秒一拍）、设备名、地址候选、分享设置。
// 组件只读这里的投影，不自己发请求。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { devicesQueryKey, fetchDevices } from '@tmex/api-client';
import type { ShareRecord, ShareSettings } from '@tmex/shared/share';
import { useRuntime } from '@tmex/stores/react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SETTINGS_STALE_MS } from '../data-prefetch';
import {
  type ShareListResponse,
  type ShareOriginsResponse,
  deleteShare,
  fetchShareSettings,
  getShareOrigins,
  getSharePassword,
  listShares,
  revokeShare,
  saveShareSettings,
  shareErrorKey,
  shareOriginsQueryKey,
  shareQueryKey,
  shareSettingsQueryKey,
  updateSharePassword,
} from './share-api';

/** 进行中的分享要看在线人数与剩余期限，一拍 10 秒；标签不在前台时 react-query 自动停。 */
export const SHARE_POLL_MS = 10_000;

const EMPTY_LIST: ShareListResponse = { active: [], history: [] };

/** 服务端 message 是英文，界面只认契约错误码；没有码的失败走通用兜底。 */
type Translate = (key: string) => string;

function errorText(t: Translate, error: unknown): string | null {
  return error ? t(shareErrorKey(error)) : null;
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
  /** 取回明文密码；失败原样抛出，由对话框就地翻译（旧分享的 409 要单独说明）。 */
  fetchPassword: (shareId: string) => Promise<string>;
  /** 改密码；返回被断开的观看者数量。 */
  changePassword: (shareId: string, password: string, endSessions: boolean) => Promise<number>;
  revoke: (record: ShareRecord) => void;
  remove: (record: ShareRecord) => void;
  saveSettings: (next: ShareSettings) => void;
}

export function useShareTab(): ShareTabModel {
  const { t } = useTranslation();
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
        setActionError(shareErrorKey(error));
      } finally {
        setBusyShareId(null);
      }
    },
    [queryClient]
  );

  // 密码两族动作的失败要就地摆在对话框里（旧分享不可查看、密码太短），
  // 不能像 revoke/remove 那样吞进页头的 actionError，所以只借这里的「行内忙」标记。
  const runPasswordAction = useCallback(
    async <T>(shareId: string, action: () => Promise<T>): Promise<T> => {
      setBusyShareId(shareId);
      try {
        return await action();
      } finally {
        setBusyShareId(null);
      }
    },
    []
  );

  const fetchPassword = useCallback(
    (shareId: string) =>
      runPasswordAction(shareId, async () => (await getSharePassword(apiClient, shareId)).password),
    [apiClient, runPasswordAction]
  );

  const changePassword = useCallback(
    (shareId: string, password: string, endSessions: boolean) =>
      runPasswordAction(shareId, async () => {
        const result = await updateSharePassword(apiClient, shareId, { password, endSessions });
        await queryClient.invalidateQueries({ queryKey: shareQueryKey() });
        return result.endedSessions;
      }),
    [apiClient, queryClient, runPasswordAction]
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
    loadError: errorText(t, listQuery.error),
    deviceName: (deviceId: string) => deviceNames.get(deviceId) ?? null,
    origins: originsQuery.data ?? null,
    settings: settingsQuery.data ?? null,
    settingsError: errorText(t, settingsQuery.error),
    busyShareId,
    actionError: actionError === null ? null : t(actionError),
    savingSettings: settingsMutation.isPending,
    saveError: errorText(t, settingsMutation.error),
    refresh,
    fetchPassword,
    changePassword,
    revoke: (record) => void runAction(record, () => revokeShare(apiClient, record.id)),
    remove: (record) => void runAction(record, () => deleteShare(apiClient, record.id)),
    saveSettings: (next) => settingsMutation.mutate(next),
  };
}
