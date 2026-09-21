// 「在线但没有该 node 会话」那一行的呈现，三档互斥：静默登录在途给转圈、从没试过给折叠入口、
// 其余摆失败说明与可点的入口。判定与 DOM 都在这里，外层只负责接线（在不在场、要不要自动登）。

import { NodeLoginButton } from '@/auth/NodeLoginButton';
import { NodeRetryConnectButton } from '@/auth/NodeRetryConnectButton';
import { offerNodeLogin } from '@/auth/login-failure-kind';
import { nodeLoginFailureTextKey } from '@/auth/login-failure-text';
import type { NodeLoginGate } from '@/auth/use-node-login';
import { cn } from '@vibeterm/ui';
import { ChevronRight, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SidebarNodeEntry } from './sidebar-node-model';

/** 失败这一档该说什么、该给哪几个入口。 */
export interface SignInFailureView {
  errorKey: string | null;
  offerLogin: boolean;
  offerRetry: boolean;
}

export function signInFailureView(gate: NodeLoginGate): SignInFailureView {
  // 传输层失败不给登录入口：点了只是在抖动的链路上再叠一次拨号。
  const offerLogin = offerNodeLogin(gate.code);
  return {
    errorKey: nodeLoginFailureTextKey(gate.code, gate.retrying),
    offerLogin,
    // 自动重试的额度用完了才给「重试连接」，否则等退避自己到点。
    offerRetry: !offerLogin && !gate.retrying,
  };
}

function SignInPending({ runtimeNodeId }: { runtimeNodeId: string }) {
  const { t } = useTranslation();
  return (
    <div
      className="vibeterm-fade flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
      data-testid={`sidebar-node-pending-${runtimeNodeId}`}
    >
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
      <span className="truncate">{t('auth.node.loggingIn')}</span>
    </div>
  );
}

function SignInExpand({
  runtimeNodeId,
  onExpand,
}: {
  runtimeNodeId: string;
  onExpand: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors duration-(--vibeterm-motion-fast) ease-out hover:bg-sidebar-accent hover:text-foreground motion-reduce:transition-none"
      data-testid={`sidebar-node-expand-${runtimeNodeId}`}
      onClick={onExpand}
    >
      <ChevronRight className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{t('auth.node.loginToThisNode')}</span>
    </button>
  );
}

function SignInFailure({ node, view }: { node: SidebarNodeEntry; view: SignInFailureView }) {
  const { t } = useTranslation();
  return (
    <div className="vibeterm-fade flex flex-col gap-1">
      {view.errorKey ? (
        <span
          className={cn(
            'px-1 text-[10px]',
            view.offerLogin ? 'text-destructive' : 'text-muted-foreground'
          )}
          data-testid={`sidebar-node-error-${node.runtimeNodeId}`}
        >
          {t(view.errorKey)}
        </span>
      ) : null}
      {view.offerLogin && (
        <NodeLoginButton nodeId={node.runtimeNodeId} nodeName={node.name} className="w-full" />
      )}
      {view.offerRetry && (
        <NodeRetryConnectButton
          nodeId={node.runtimeNodeId}
          nodeName={node.name}
          className="w-full"
        />
      )}
    </div>
  );
}

export function SidebarNodeSignInBody({
  node,
  gate,
  expanded,
  eager,
  onExpand,
}: {
  node: SidebarNodeEntry;
  gate: NodeLoginGate;
  expanded: boolean;
  eager: boolean;
  onExpand: () => void;
}) {
  // 自动登录进行中就别先闪一下「登录该节点」：那条按钮点下去做的正是同一件事。
  if (gate.status === 'pending' && (expanded || eager)) {
    return <SignInPending runtimeNodeId={node.runtimeNodeId} />;
  }
  if (!expanded && gate.code === null) {
    return <SignInExpand runtimeNodeId={node.runtimeNodeId} onExpand={onExpand} />;
  }
  return <SignInFailure node={node} view={signInFailureView(gate)} />;
}
