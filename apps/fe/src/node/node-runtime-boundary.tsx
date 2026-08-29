// node 运行时边界：`/n/:nodeId/*` 与旧路由（等价于 `self`）各自的子树运行时。
// 取 nodeId → NodeConnectionManager 取运行时 → 注入 RuntimeProvider + 该 node 的
// QueryClient + GlobalDeviceProvider；卸载时归还引用。
//
// 顺带守住「用到才登录」：进入某台远端 node 的路由时，如果它在线但还没有该 node 的会话，
// 先用内存里的会话钥静默登录，登进去之前不渲染子树——否则页面上的请求会整片 401。

import { QueryClientProvider } from '@tanstack/react-query';
import { normalizeNodeId, setSiteFallbackReader, useNodeRuntime } from '@tmex/stores';
import { RuntimeProvider } from '@tmex/stores/react';
import { Loader2 } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { NodeLoginButton } from '@/auth/NodeLoginButton';
import { loginErrorKey } from '@/auth/login-errors';
import { type NodeLoginGate, useNodeLoginGate } from '@/auth/use-node-login';
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
  const gate = useNodeLoginGate(nodeId);

  // buildBrowserTitle 等非 React 代码的站点名兜底跟随当前活跃 node。
  useEffect(() => {
    return setSiteFallbackReader(() => runtime.stores.site.getState().settings);
  }, [runtime]);

  return (
    <RuntimeProvider runtime={runtime}>
      <QueryClientProvider client={queryClient}>
        <GlobalDeviceProvider>
          {gate.status === 'ready' ? children : <NodeGateScreen nodeId={nodeId} gate={gate} />}
        </GlobalDeviceProvider>
      </QueryClientProvider>
    </RuntimeProvider>
  );
}

/**
 * 静默登录还没完成 / 已经失败时代替整个子树的整页状态。
 * 失败时给出「登录此节点」（会话钥没了就跳 `/login?node=`）与回本机的出口——
 * 这时候侧边栏还没渲染，用户必须能从这里走出去。
 */
function NodeGateScreen({ nodeId, gate }: { nodeId: string; gate: NodeLoginGate }) {
  const { t } = useTranslation();

  if (gate.status === 'pending') {
    return (
      <div
        className="flex h-full items-center justify-center p-8 text-muted-foreground"
        data-testid={`node-gate-pending-${nodeId}`}
      >
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
      data-testid={`node-gate-blocked-${nodeId}`}
    >
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
