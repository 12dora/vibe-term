// node 运行时边界：`/n/:nodeId/*` 与旧路由（等价于 `self`）各自的**页面区**运行时。
// 取 nodeId → NodeConnectionManager 取运行时 → 注入 RuntimeProvider + 该 node 的
// QueryClient + GlobalDeviceProvider；卸载时归还引用。
//
// 边界只包页面区，不包外壳：`RuntimeProvider` 换 runtime 实例即整棵子树重挂
// （见 `stores/react.tsx` 的 runtimeSubtreeKey——react-query 的 observer 在首次挂载时就和
// 当时的 QueryClient 绑死，必须靠重挂换掉），侧边栏若在边界内，切 node 就会整条闪一下。
// 外壳挂在常驻的 entry 运行时下，聚合视图里各 node 的设备树各自走 `NodeRuntimeScope`。
//
// 顺带守住「用到才登录」：进入某台远端 node 的路由时，如果它在线但还没有该 node 的会话，
// 先用内存里的会话钥静默登录，登进去之前不渲染页面——否则页面上的请求会整片 401。
// 门闸同样只挡页面区，侧边栏照常在，用户随时能切去别的 node。

import { QueryClientProvider } from '@tanstack/react-query';
import { parseNodeIdFromPath } from '@tmex/api-client';
import { setSiteFallbackReader, useNodeRuntime } from '@tmex/stores';
import { RuntimeProvider } from '@tmex/stores/react';
import { SidebarTrigger } from '@tmex/ui/sidebar';
import { Loader2 } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';

import { NodeLoginButton } from '@/auth/NodeLoginButton';
import { loginErrorKey } from '@/auth/login-errors';
import { type NodeLoginGate, useNodeLoginGate } from '@/auth/use-node-login';
import { GlobalDeviceProvider } from '@/components/global-device-provider';
import { appNodeRuntimes, nodeQueryClient } from './node-runtimes';

/**
 * 路由参数里的 nodeId；缺省（旧路由）即 `self`。
 *
 * 从 pathname 解析而不是 `useParams()`：页面路由挂在 `/n/:nodeId` 的**子级**，而
 * `useParams()` 只给到当前 match 为止累积的参数，外壳所在的父级路由读不到 `:nodeId`。
 */
export function useRouteNodeId(): string {
  return parseNodeIdFromPath(useLocation().pathname);
}

/** 页面区的 node 运行时。外壳（侧边栏）必须留在它外面，否则切 node 会整条重挂。 */
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

/**
 * 「用到才登录」的门闸：静默登录没完成 / 已失败时，用整页状态顶掉**页面区**。
 * 必须放在 `NodeRuntimeBoundary` 内部——门闸放行前页面一个请求都不该发。
 */
export function NodeRouteGate({ children }: { children: ReactNode }) {
  const nodeId = useRouteNodeId();
  const gate = useNodeLoginGate(nodeId);
  if (gate.status === 'ready') return <>{children}</>;
  return <NodeGateScreen nodeId={nodeId} gate={gate} />;
}

/**
 * 失败时给出「登录此节点」（会话钥没了就跳 `/login?node=`）与回本机的出口；
 * 手机上侧边栏是抽屉，这里补一个开合按钮，免得用户被困在这一屏。
 */
function NodeGateScreen({ nodeId, gate }: { nodeId: string; gate: NodeLoginGate }) {
  const { t } = useTranslation();

  if (gate.status === 'pending') {
    return (
      <div
        className="flex h-full items-center justify-center p-8 text-muted-foreground"
        data-testid={`node-gate-pending-${nodeId}`}
      >
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
      data-testid={`node-gate-blocked-${nodeId}`}
    >
      <SidebarTrigger className="absolute top-3 left-3" data-testid="node-gate-sidebar-open" />
      <p className="text-sm text-muted-foreground">{t('auth.node.signInRequired')}</p>
      {gate.code ? (
        <p className="text-sm text-destructive" data-testid="node-gate-error">
          {t(loginErrorKey(gate.code, 'password'))}
        </p>
      ) : null}
      <NodeLoginButton nodeId={nodeId} />
      <Link to="/" className="text-xs text-muted-foreground underline underline-offset-4">
        {t('auth.node.backToLocal')}
      </Link>
    </div>
  );
}
