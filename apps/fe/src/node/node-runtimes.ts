// 宿主级的 node 运行时管理器与每 node 的 QueryClient。
//
// - 运行时（连接 / ApiClient / store）由 NodeConnectionManager 按 nodeId 懒建并引用计数。
// - React Query 缓存按 node 隔离：不是给每个 query key 加 nodeId 前缀（那要求改动所有
//   包内调用点，且会破坏包内既有的 `invalidateQueries(['files'])` 这类跨 key 失效），
//   而是每个 node 一个 QueryClient——隔离更彻底，且 key 语义完全不变。

import { sonnerNotificationSink } from '@/lib/sonner-notification-sink';
import { QueryClient } from '@tanstack/react-query';
import { NodeConnectionManager, normalizeNodeId } from '@tmex/stores';

export const appNodeRuntimes = new NodeConnectionManager({
  // 宿主只有一个 toaster，全部 node 共用同一个通知出口（不再经全局可变默认 sink）。
  notifications: sonnerNotificationSink,
});

function createNodeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5000,
        retry: 1,
      },
    },
  });
}

const queryClients = new Map<string, QueryClient>();

/** 取该 node 的 QueryClient（懒建）。 */
export function nodeQueryClient(nodeId: string | undefined): QueryClient {
  const id = normalizeNodeId(nodeId);
  let client = queryClients.get(id);
  if (!client) {
    client = createNodeQueryClient();
    queryClients.set(id, client);
  }
  return client;
}

/** 释放该 node 的查询缓存（运行时被回收时调用）。 */
export function disposeNodeQueryClient(nodeId: string | undefined): void {
  const id = normalizeNodeId(nodeId);
  const client = queryClients.get(id);
  if (!client) return;
  queryClients.delete(id);
  client.clear();
}
