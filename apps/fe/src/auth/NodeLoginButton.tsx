// 「登录此节点」按钮。F4-3 会把它放进侧边栏的 node 行。
// sk_sess 还在（内存里，或能从 IndexedDB 恢复）时直接静默完成登录；已失效则带 `?node=` 去登录页。

import { Button } from '@tmex/ui/button';
import { Loader2, LogIn } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import type { LoginFailureCode, LoginNodeResult } from './session-key-store';
import { ensureNodeLogin } from './session-key-store';

export interface NodeLoginButtonProps {
  nodeId: string;
  nodeName?: string;
  className?: string;
  size?: 'sm' | 'default' | 'lg' | 'icon';
  onLoggedIn?: (nodeId: string) => void;
}

type State = { status: 'idle' | 'pending' | 'ok' } | { status: 'error'; code: LoginFailureCode };

/**
 * 点按钮就是**用户主动发起**的登录，因此允许当场弹一次通行密钥仪式
 * （`allowPasskeyPrompt`）。后台静默登录不给这个权限，那种场合弹系统仪式是惊吓。
 *
 * 没有它的话，从旧会话恢复出来、盘上又没有断言的用户会陷在这里：每点一次都发同一个不带
 * 断言的请求，服务端每次都回 `PASSKEY_REQUIRED`，仪式永远没机会做。
 */
export function loginFromNodeButton(nodeId: string): Promise<LoginNodeResult> {
  return ensureNodeLogin(nodeId, { allowPasskeyPrompt: true });
}

/**
 * 这次失败要不要回登录页重新交互。
 *
 * `PASSKEY_REQUIRED` 也在其中：走到这一步说明手上那份断言服务端不认、当场补仪式这条路也没走通，
 * 只能回登录页从密码走一遍完整流程。
 */
export function needsLoginPage(code: LoginFailureCode): boolean {
  return code === 'NO_SESSION_KEY' || code === 'TOTP_REQUIRED' || code === 'PASSKEY_REQUIRED';
}

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

  // 会话钥在不在，只有 `ensureNodeLogin()` 说了算——它会先等一次 IndexedDB 恢复，
  // 同步问 `hasSessionKey()` 在 PWA 冷启动的第一帧永远是「没有」。
  const onClick = useCallback(async () => {
    setState({ status: 'pending' });
    const result = await loginFromNodeButton(nodeId);
    if (result.ok) {
      setState({ status: 'ok' });
      onLoggedIn?.(nodeId);
      return;
    }
    setState({ status: 'error', code: result.code });
    if (needsLoginPage(result.code)) goToLoginPage();
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
