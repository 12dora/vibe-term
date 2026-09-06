// 「分享」标签的数据来源：节点清单、跨节点的进行中列表、跨节点的设备名。
//
// 分享记录存在被分享终端所在的那台节点上，只问当前路由节点会漏掉别处的分享（这正是
// 「明明分享着却看不见」的成因）。这里照端口映射弹窗的做法，对每台在线且已登录的节点各发
// 一次 `GET /n/<id>/api/share`：查询按节点分片，单台失败只摘掉那一行来源，不会整表变空。

import { useMeshNodes, useSharedAuthMode } from '@/node/mesh-nodes';
import { type DialogNodeOption, toDialogNodeOptions } from '@/pages/devices/dialog-nodes';
import { type UseQueryOptions, useQueries, useQuery } from '@tanstack/react-query';
import {
  type DevicesResponse,
  createNodeApiClient,
  devicesQueryKey,
  fetchDevices,
} from '@tmex/api-client';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SETTINGS_STALE_MS } from '../data-prefetch';
import { type ShareListResponse, listShares, shareNodeQueryKey } from './share-api';
import type { ShareRow, ShareRowSource } from './share-rows';
import { failedShareNodeNames, flattenActiveShares } from './share-rows';

/** 进行中的分享要看在线人数与剩余期限，一拍 10 秒；标签不在前台时 react-query 自动停。 */
export const SHARE_POLL_MS = 10_000;

export interface ShareNodesModel {
  /** 展示顺序：本机在前（`toDialogNodeOptions` 已排好）。 */
  options: DialogNodeOption[];
  /** 在线且已登录，能真正发请求的那些。 */
  usable: DialogNodeOption[];
  /** mesh 里不止本机时才摆节点列与「仅本节点」的提示。 */
  multiNode: boolean;
}

export function useShareNodes(): ShareNodesModel {
  const { t } = useTranslation();
  const { meshEnabled, entryNodeId } = useSharedAuthMode();
  const { nodes } = useMeshNodes({ enabled: meshEnabled });
  const selfName = t('device.addTo.self');

  const options = useMemo(
    () => toDialogNodeOptions(nodes, entryNodeId, selfName),
    [nodes, entryNodeId, selfName]
  );
  const usable = useMemo(() => options.filter((option) => option.usable), [options]);

  return { options, usable, multiNode: options.length > 1 };
}

/**
 * 一台节点的分享列表查询选项。聚合查询与「本节点历史」用的是同一个键，因此必须共用这一份
 * 选项：同键不同选项在 react-query 里由最后一个观察者说了算，行为会随挂载顺序漂。
 */
export function shareListQueryOptions(nodeId: string): UseQueryOptions<ShareListResponse> {
  return {
    queryKey: shareNodeQueryKey(nodeId),
    queryFn: ({ signal }) => listShares(createNodeApiClient(nodeId), {}, signal),
    refetchInterval: SHARE_POLL_MS,
    retry: false,
  } as UseQueryOptions<ShareListResponse>;
}

export interface ActiveSharesModel {
  rows: ShareRow[];
  loading: boolean;
  /** 没拉回来的节点名；空数组即全部就位。 */
  failedNodes: string[];
  /** 有节点可问，但一台都没成功——这才算整表失败。 */
  allFailed: boolean;
  /** 相对时间的基准：最近一次成功落地的时刻。 */
  updatedAt: number;
}

export function useActiveShares(nodes: DialogNodeOption[]): ActiveSharesModel {
  const results = useQueries({
    queries: nodes.map((node) => shareListQueryOptions(node.id)),
  });

  const rows = useMemo(() => flattenActiveShares(nodes, results), [nodes, results]);
  const failedNodes = useMemo(() => failedShareNodeNames(nodes, results), [nodes, results]);
  const updatedAt = results.reduce((latest, result) => Math.max(latest, result.dataUpdatedAt), 0);

  return {
    rows,
    loading: results.some((result) => result.isPending),
    failedNodes,
    allFailed: results.length > 0 && results.every((result) => result.isError),
    updatedAt: updatedAt || Date.now(),
  };
}

/** 本节点的历史与设置在同一条列表响应里；键与聚合查询一致，两边只发一次请求。 */
export function useNodeShareList(nodeId: string) {
  return useQuery(shareListQueryOptions(nodeId));
}

export type ShareDeviceName = (nodeId: string, deviceId: string) => string | null;

/** 终端列要的设备名各在各自的节点上；按节点分片缓存，设备 id 不跨节点比较。 */
export function useShareDeviceNames(nodes: readonly ShareRowSource[]): ShareDeviceName {
  const results = useQueries({
    queries: nodes.map((node) => ({
      queryKey: [...devicesQueryKey, node.id] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchDevices(createNodeApiClient(node.id), { signal }),
      staleTime: SETTINGS_STALE_MS,
      retry: false,
    })),
  });

  return useMemo(() => {
    const names = new Map<string, string>();
    nodes.forEach((node, index) => {
      const data = results[index]?.data as DevicesResponse | undefined;
      for (const device of data?.devices ?? []) names.set(`${node.id}:${device.id}`, device.name);
    });
    return (nodeId: string, deviceId: string) => names.get(`${nodeId}:${deviceId}`) ?? null;
  }, [nodes, results]);
}
