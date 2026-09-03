// 单个目录节点的列表数据：展开态、查询与轮询、以及刷新后的展开态修正。

import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { type FileApiError, fetchFileList } from '@tmex/api-client';
import type { FileEntryDto, FileErrorCode, ListFilesResponse } from '@tmex/shared';
import { fileNodeKey } from '@tmex/stores';
import { useFileTreeStore, useRuntime } from '@tmex/stores/react';
import { useCallback, useEffect, useRef } from 'react';
import { stabilizeFileEntries } from './file-entry-identity';
import { staleChildExpansionPaths } from './file-tree-logic';

const LIST_STALE_MS = 2000; // 收起+展开重试的防抖窗口
const LIST_POLL_MS = 30_000; // 仅对健康的已展开目录轮询

/** 目录列表的查询键；树根的共享右键菜单也按它回查命中行的 entry */
export function fileListQueryKey(rootId: string, path: string): readonly unknown[] {
  return ['files', 'list', rootId, path];
}

export interface DirectoryListing {
  /** `${rootId}\n${path}`，展开态与 toast 去重的键 */
  nodeKey: string;
  expanded: boolean;
  toggle: () => void;
  query: UseQueryResult<ListFilesResponse, FileApiError>;
  /** 引用稳定化后的目录项（见 file-entry-identity）；无数据时 undefined */
  entries?: readonly FileEntryDto[];
  errCode?: FileErrorCode;
}

export function useDirectoryListing(rootId: string, path: string): DirectoryListing {
  const runtime = useRuntime();
  const nodeKey = fileNodeKey(rootId, path);
  const expanded = useFileTreeStore((s) => Boolean(s.expanded[nodeKey]));
  const toggleNode = useFileTreeStore((s) => s.toggle);

  const query = useQuery<ListFilesResponse, FileApiError>({
    queryKey: fileListQueryKey(rootId, path),
    queryFn: () => fetchFileList(rootId, path, runtime.apiClient),
    enabled: expanded,
    staleTime: LIST_STALE_MS,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.status === 'error' ? false : LIST_POLL_MS),
    refetchIntervalInBackground: false,
  });

  const errCode = query.error?.code;

  // 30 秒一轮的轮询会让插入/删除点之后的 entry 全部换新对象，这里按路径复用上一份，
  // 保住行级 memo（缓存写在 ref 里，语义上是纯 memo，不参与渲染输出以外的任何状态）。
  const entriesRef = useRef<readonly FileEntryDto[] | undefined>(undefined);
  const fetched = query.data?.entries;
  const entries = fetched ? stabilizeFileEntries(entriesRef.current, fetched) : undefined;
  if (entries) entriesRef.current = entries;

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

  return { nodeKey, expanded, toggle, query, entries, errCode };
}
