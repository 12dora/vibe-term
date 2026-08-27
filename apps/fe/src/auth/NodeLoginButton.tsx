// 「登录此节点」按钮。F4-3 会把它放进侧边栏的 node 行。
// sk_sess 还在内存时直接静默完成登录；已失效则带 `?node=` 去登录页。

import { Button } from '@tmex/ui/button';
import { Loader2, LogIn } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { type LoginFailureCode, hasSessionKey, loginToNode } from './session-key-store';

export interface NodeLoginButtonProps {
  nodeId: string;
  nodeName?: string;
  className?: string;
  size?: 'sm' | 'default' | 'lg' | 'icon';
  onLoggedIn?: (nodeId: string) => void;
}

type State = { status: 'idle' | 'pending' | 'ok' } | { status: 'error'; code: LoginFailureCode };

export function NodeLoginButton({
  nodeId,
  nodeName,
  className,
  size = 'sm',
  onLoggedIn,
}: NodeLoginButtonProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<State>({ status: 'idle' });

  const goToLoginPage = useCallback(() => {
    const next = `${location.pathname}${location.search}`;
    navigate(`/login?node=${encodeURIComponent(nodeId)}&next=${encodeURIComponent(next)}`);
  }, [location.pathname, location.search, navigate, nodeId]);

  const onClick = useCallback(async () => {
    if (!hasSessionKey()) {
      goToLoginPage();
      return;
    }
    setState({ status: 'pending' });
    const result = await loginToNode(nodeId);
    if (result.ok) {
      setState({ status: 'ok' });
      onLoggedIn?.(nodeId);
      return;
    }
    setState({ status: 'error', code: result.code });
    // 会话钥不在 / 需要 TOTP：只能回登录页重新交互。
    if (result.code === 'NO_SESSION_KEY' || result.code === 'TOTP_REQUIRED') {
      goToLoginPage();
    }
  }, [goToLoginPage, nodeId, onLoggedIn]);

  const pending = state.status === 'pending';
  const label = pending
    ? t('auth.node.loggingIn')
    : state.status === 'error'
      ? t('auth.node.retryLogin')
      : t('auth.node.loginToThisNode');

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      className={className}
      disabled={pending}
      onClick={() => void onClick()}
      data-testid={`node-login-${nodeId}`}
      title={nodeName ? `${label} — ${nodeName}` : label}
    >
      {pending ? <Loader2 className="animate-spin" /> : <LogIn />}
      <span className="truncate">{label}</span>
    </Button>
  );
}

export default NodeLoginButton;
