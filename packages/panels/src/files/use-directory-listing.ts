// 单个目录节点的列表数据：展开态、查询与轮询、以及刷新后的展开态修正。

import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { type FileApiError, fetchFileList } from '@tmex/api-client';
import type { FileErrorCode, ListFilesResponse } from '@tmex/shared';
import { fileNodeKey } from '@tmex/stores';
import { useFileTreeStore, useRuntime } from '@tmex/stores/react';
import { useCallback, useEffect } from 'react';
import { staleChildExpansionPaths } from './file-tree-logic';

const LIST_STALE_MS = 2000; // 收起+展开重试的防抖窗口
const LIST_POLL_MS = 30_000; // 仅对健康的已展开目录轮询

export interface DirectoryListing {
  /** `${rootId}\n${path}`，展开态与 toast 去重的键 */
  nodeKey: string;
  expanded: boolean;
  toggle: () => void;
  query: UseQueryResult<ListFilesResponse, FileApiError>;
  errCode?: FileErrorCode;
}

export function useDirectoryListing(rootId: string, path: string): DirectoryListing {
  const runtime = useRuntime();
  const nodeKey = fileNodeKey(rootId, path);
  const expanded = useFileTreeStore((s) => Boolean(s.expanded[nodeKey]));
  const toggleNode = useFileTreeStore((s) => s.toggle);

  const query = useQuery<ListFilesResponse, FileApiError>({
    queryKey: ['files', 'list', rootId, path],
    queryFn: () => fetchFileList(rootId, path, runtime.apiClient),
    enabled: expanded,
    staleTime: LIST_STALE_MS,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.status === 'error' ? false : LIST_POLL_MS),
    refetchIntervalInBackground: false,
  });

  const errCode = query.error?.code;

  // reconcile：成功刷新后，把「曾展开但已消失」的直接子目录折叠掉（同一 root 下）
  useEffect(() => {
    if (!query.data) return;
    const childDirs = new Set(
      query.data.entries.filter((e) => e.type === 'dir').map((e) => e.path)
    );
    const store = runtime.stores.fileTree.getState();
    for (const stale of staleChildExpansionPaths(
      Object.keys(store.expanded),
      rootId,
      path,
      childDirs
    )) {
      store.collapse(rootId, stale);
    }
  }, [query.data, rootId, path, runtime]);

  const toggle = useCallback(() => toggleNode(rootId, path), [toggleNode, rootId, path]);

  return { nodeKey, expanded, toggle, query, errCode };
}
