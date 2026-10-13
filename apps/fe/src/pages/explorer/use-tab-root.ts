// 标签页所在目录根的展示信息：只读该节点已有的 ['files','roots'] 缓存，不为标题另发请求。
// 浏览器主体（或侧栏）拉到目录根后缓存更新，这里跟着刷新。

import { nodeQueryClient } from '@/node/node-runtimes';
import type { FileRootDto, ListFileRootsResponse } from '@vibeterm/shared';
import { useCallback, useSyncExternalStore } from 'react';

const FILE_ROOTS_QUERY_KEY = ['files', 'roots'];

function cachedRoot(nodeId: string, rootId: string): FileRootDto | null {
  const data = nodeQueryClient(nodeId).getQueryData<ListFileRootsResponse>(FILE_ROOTS_QUERY_KEY);
  return data?.roots.find((root) => root.id === rootId) ?? null;
}

/** `nodeId` 传 null（节点未知）时不碰查询缓存，避免给不存在的节点建 QueryClient */
export function useTabRoot(nodeId: string | null, rootId: string): FileRootDto | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (nodeId === null) return () => {};
      return nodeQueryClient(nodeId).getQueryCache().subscribe(onChange);
    },
    [nodeId]
  );
  const getSnapshot = useCallback(
    () => (nodeId === null ? null : cachedRoot(nodeId, rootId)),
    [nodeId, rootId]
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
