// 传输弹窗的两组查询：节点的文件根、以及某个根下某个目录的条目。
// 两者都接受显式的 `ApiClient`（`createNodeApiClient(nodeId)` 建的），所以同一个 QueryClient
// 里可以并存多个节点的缓存——查询键第二段就是 nodeId。

import { type ApiClient, fetchFileList, fetchFileRoots } from '@vibeterm/api-client';
import type { ListFileRootsResponse, ListFilesResponse } from '@vibeterm/shared';

export const TRANSFER_QUERY_KEY = 'devices-transfer';

export function fileRootsQueryOptions(nodeId: string, client: ApiClient) {
  return {
    queryKey: [TRANSFER_QUERY_KEY, 'roots', nodeId] as const,
    queryFn: (): Promise<ListFileRootsResponse> => fetchFileRoots(client),
  };
}

export function fileListQueryOptions(
  nodeId: string,
  rootId: string,
  path: string,
  client: ApiClient
) {
  return {
    queryKey: [TRANSFER_QUERY_KEY, 'list', nodeId, rootId, path] as const,
    queryFn: (): Promise<ListFilesResponse> => fetchFileList(rootId, path || undefined, client),
  };
}
