// 按**显式 nodeId**（而不是路由参数）挂载一个 node 的运行时子树。
//
// 与 `NodeRuntimeBoundary` 的区别：后者服务于路由（`/n/:nodeId/*`），同一时刻只有一个；
// 本组件服务于聚合视图（侧边栏同时展示多个 node 的设备树），可以并存多份。
// 两者都经 `useNodeRuntime` 引用计数，卸载即归还，宽限期后释放连接。
//
// 刻意**不**注册 `setSiteFallbackReader`：站点名兜底跟随的是当前活跃路由 node，
// 聚合视图里的旁路 node 不应该抢它。
//
// `offline`：设备页会保留掉线 node 的子树（卡片不消失），这种子树不该再发它的设备列表请求
// ——每个 node 一个 QueryClient，N 个离线 node 就是 N 条注定失败的 `/api/devices`。

import { QueryClientProvider } from '@tanstack/react-query';
import { useNodeRuntime } from '@tmex/stores';
import { RuntimeProvider } from '@tmex/stores/react';
import type { ReactNode } from 'react';

import { GlobalDeviceProvider } from '@/components/global-device-provider';
import { appNodeRuntimes, nodeQueryClient } from './node-runtimes';

export function NodeRuntimeScope({
  nodeId,
  offline = false,
  children,
}: {
  nodeId: string;
  /** 该 node 已离线：子树照常挂载，但不发它的设备列表请求。 */
  offline?: boolean;
  children: ReactNode;
}) {
  const runtime = useNodeRuntime(nodeId, appNodeRuntimes);
  return (
    <RuntimeProvider runtime={runtime}>
      <QueryClientProvider client={nodeQueryClient(nodeId)}>
        <GlobalDeviceProvider offline={offline}>{children}</GlobalDeviceProvider>
      </QueryClientProvider>
    </RuntimeProvider>
  );
}
