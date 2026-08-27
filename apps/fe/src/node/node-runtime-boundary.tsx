// node 运行时边界：`/n/:nodeId/*` 与旧路由（等价于 `self`）各自的子树运行时。
// 取 nodeId → NodeConnectionManager 取运行时 → 注入 RuntimeProvider + 该 node 的
// QueryClient + GlobalDeviceProvider；卸载时归还引用。

import { QueryClientProvider } from '@tanstack/react-query';
import { normalizeNodeId, setSiteFallbackReader, useNodeRuntime } from '@tmex/stores';
import { RuntimeProvider } from '@tmex/stores/react';
import { type ReactNode, useEffect } from 'react';
import { useParams } from 'react-router';

import { GlobalDeviceProvider } from '@/components/global-device-provider';
import { appNodeRuntimes, nodeQueryClient } from './node-runtimes';

/** 路由参数里的 nodeId；缺省（旧路由）即 `self`。 */
export function useRouteNodeId(): string {
  const { nodeId } = useParams();
  return normalizeNodeId(nodeId);
}

export function NodeRuntimeBoundary({ children }: { children: ReactNode }) {
  const nodeId = useRouteNodeId();
  const runtime = useNodeRuntime(nodeId, appNodeRuntimes);
  const queryClient = nodeQueryClient(nodeId);

  // buildBrowserTitle 等非 React 代码的站点名兜底跟随当前活跃 node。
  useEffect(() => {
    return setSiteFallbackReader(() => runtime.stores.site.getState().settings);
  }, [runtime]);

  return (
    <RuntimeProvider runtime={runtime}>
      <QueryClientProvider client={queryClient}>
        <GlobalDeviceProvider>{children}</GlobalDeviceProvider>
      </QueryClientProvider>
    </RuntimeProvider>
  );
}
