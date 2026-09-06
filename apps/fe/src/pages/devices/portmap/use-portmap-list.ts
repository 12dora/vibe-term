// 映射列表：把所有在线已登录节点的 `GET /n/<id>/api/portmap` 聚合成一张表，
// 弹窗打开期间每 2 秒轮询一次（关闭即停，请求由 react-query 随查询卸载中止）。

import { useQueries } from '@tanstack/react-query';
import { createNodeApiClient, listPortMaps } from '@vibeterm/api-client';
import type { PortMapDto } from '@vibeterm/shared';
import { useMemo } from 'react';

import type { DialogNodeOption } from '../dialog-nodes';

export const PORTMAP_QUERY_KEY = 'devices-portmap';
export const PORTMAP_POLL_MS = 2000;

export interface PortMapRow extends PortMapDto {
  /** 监听方（A）的运行时 node id 与展示名。 */
  nodeId: string;
  nodeName: string;
}

/** 把每个节点的返回摊平成行；同一节点内保持后端顺序，节点之间按选项顺序。 */
export function flattenPortMaps(
  nodes: readonly DialogNodeOption[],
  results: readonly { data?: PortMapDto[] }[]
): PortMapRow[] {
  const rows: PortMapRow[] = [];
  nodes.forEach((node, index) => {
    for (const map of results[index]?.data ?? []) {
      rows.push({ ...map, nodeId: node.id, nodeName: node.name });
    }
  });
  return rows;
}

export interface PortMapListResult {
  rows: PortMapRow[];
  loading: boolean;
  failed: boolean;
  refetch: () => void;
}

export function usePortMapList(open: boolean, nodes: DialogNodeOption[]): PortMapListResult {
  const usable = useMemo(() => nodes.filter((node) => node.usable), [nodes]);

  const results = useQueries({
    queries: usable.map((node) => ({
      queryKey: [PORTMAP_QUERY_KEY, node.id] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listPortMaps(createNodeApiClient(node.id), signal),
      enabled: open,
      refetchInterval: open ? PORTMAP_POLL_MS : false,
      retry: false,
    })),
  });

  const rows = useMemo(() => flattenPortMaps(usable, results), [usable, results]);

  return {
    rows,
    loading: results.some((result) => result.isPending),
    failed: results.length > 0 && results.every((result) => result.isError),
    refetch: () => {
      for (const result of results) void result.refetch();
    },
  };
}
