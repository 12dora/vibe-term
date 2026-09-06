// 「分享」标签的数据与写操作：进行中的列表跨全部节点汇总，历史与分享设置仍只问本节点
//（它们是节点本地的记录与配置）。组件只读这里的投影，不自己发请求。
//
// 每一行都带着自己的 nodeId：终止、查看/修改密码、复制带密码的链接一律用那台节点的客户端，
// 失效也只失效那台节点的分片键。

import { useRouteNodeId } from '@/node/node-runtime-boundary';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createNodeApiClient } from '@vibeterm/api-client';
import type { ShareSettings } from '@vibeterm/shared/share';
import { useRuntime } from '@vibeterm/stores/react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SETTINGS_STALE_MS } from '../data-prefetch';
import { createShareRowApi } from './share-actions';
import {
  type ShareOriginsResponse,
  fetchShareSettings,
  getShareOrigins,
  saveShareSettings,
  shareErrorKey,
  shareNodeQueryKey,
  shareOriginsQueryKey,
  shareQueryKey,
  shareSettingsQueryKey,
} from './share-api';
import type { ShareRow, ShareRowSource } from './share-rows';
import { toShareRows } from './share-rows';
import { useShareRowActions } from './use-share-row-actions';
import {
  SHARE_POLL_MS,
  useActiveShares,
  useNodeShareList,
  useShareDeviceNames,
  useShareNodes,
} from './use-share-sources';

export { SHARE_POLL_MS };
export type { ShareRow };

/** 服务端 message 是英文，界面只认契约错误码；没有码的失败走通用兜底。 */
type Translate = (key: string) => string;

function errorText(t: Translate, error: unknown): string | null {
  return error ? t(shareErrorKey(error)) : null;
}

export interface ShareTabModel {
  /** 全部节点上进行中的分享，本机的排在前面。 */
  active: ShareRow[];
  /** 只有本节点的历史记录。 */
  history: ShareRow[];
  /** 相对时间的基准：随每一拍推进，中间不逐秒重渲染。 */
  now: number;
  loading: boolean;
  loadError: string | null;
  /** 没拉回来的节点名；其余节点的行照常出。 */
  failedNodes: string[];
  /** mesh 里不止一台节点：进行中摆节点列，历史加「仅本节点」的说明。 */
  multiNode: boolean;
  deviceName: (row: ShareRow) => string | null;
  origins: ShareOriginsResponse | null;
  settings: ShareSettings | null;
  settingsError: string | null;
  /** 正在写入的那一行（`shareRowKey`）：该行动作禁用。 */
  busyRowKey: string | null;
  actionError: string | null;
  savingSettings: boolean;
  saveError: string | null;
  refresh: () => void;
  /** 取回明文密码；失败原样抛出，由对话框就地翻译（旧分享的 409 要单独说明）。 */
  fetchPassword: (row: ShareRow) => Promise<string>;
  /** 改密码；返回被断开的观看者数量。 */
  changePassword: (row: ShareRow, password: string, endSessions: boolean) => Promise<number>;
  revoke: (row: ShareRow) => void;
  remove: (row: ShareRow) => void;
  saveSettings: (next: ShareSettings) => void;
}

/** 设备名按节点分别取；路由节点未必在可用清单里（未登录时仍要出本节点历史的终端名）。 */
function useDeviceNameNodes(
  usable: readonly ShareRowSource[],
  routeNodeId: string
): ShareRowSource[] {
  return useMemo(() => {
    const nodes = usable.map((node) => ({ id: node.id, name: node.name }));
    if (nodes.some((node) => node.id === routeNodeId)) return nodes;
    nodes.push({ id: routeNodeId, name: '' });
    return nodes;
  }, [usable, routeNodeId]);
}

/** 客户端工厂无状态，模块级建一次即可。 */
const rowApi = createShareRowApi(createNodeApiClient);

export function useShareTab(): ShareTabModel {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();
  const queryClient = useQueryClient();
  const routeNodeId = useRouteNodeId();
  const { options, usable, multiNode } = useShareNodes();
  const active = useActiveShares(usable);
  const localList = useNodeShareList(routeNodeId);
  const deviceNodes = useDeviceNameNodes(usable, routeNodeId);
  const lookupDeviceName = useShareDeviceNames(deviceNodes);

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

  const invalidateNode = useCallback(
    (nodeId: string) => queryClient.invalidateQueries({ queryKey: shareNodeQueryKey(nodeId) }),
    [queryClient]
  );
  const rowActions = useShareRowActions(rowApi, invalidateNode);

  const settingsMutation = useMutation({
    mutationFn: (next: ShareSettings) => saveShareSettings(apiClient, next),
    onSuccess: (saved) => {
      queryClient.setQueryData(shareSettingsQueryKey, saved);
    },
  });

  const routeNode = useMemo(
    () => options.find((option) => option.id === routeNodeId) ?? { id: routeNodeId, name: '' },
    [options, routeNodeId]
  );
  const history = useMemo(
    () => toShareRows(routeNode, localList.data?.history ?? []),
    [routeNode, localList.data]
  );

  // 一台都没成功才算整页加载失败；只挂了其中几台时列表照出，上方点名是哪几台。
  const allDown = localList.isError && (usable.length === 0 || active.allFailed);

  return {
    active: active.rows,
    history,
    now: Math.max(active.updatedAt, localList.dataUpdatedAt) || Date.now(),
    loading: active.loading || localList.isPending,
    loadError: allDown ? errorText(t, localList.error) : null,
    failedNodes: allDown ? [] : active.failedNodes,
    multiNode,
    deviceName: (row: ShareRow) => lookupDeviceName(row.nodeId, row.deviceId),
    origins: originsQuery.data ?? null,
    settings: settingsQuery.data ?? null,
    settingsError: errorText(t, settingsQuery.error),
    busyRowKey: rowActions.busyRowKey,
    actionError: rowActions.actionErrorKey === null ? null : t(rowActions.actionErrorKey),
    savingSettings: settingsMutation.isPending,
    saveError: errorText(t, settingsMutation.error),
    refresh,
    fetchPassword: rowActions.fetchPassword,
    changePassword: rowActions.changePassword,
    revoke: rowActions.revoke,
    remove: rowActions.remove,
    saveSettings: (next) => settingsMutation.mutate(next),
  };
}
