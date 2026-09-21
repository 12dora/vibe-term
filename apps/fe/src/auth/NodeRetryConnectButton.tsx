// 「重试连接」按钮：打不通的节点在自动重试额度用完之后的唯一出口。
//
// 为什么不复用「登录该节点」：打不通根本不是登录问题，把登录按钮亮出来就是引导用户去压一条
// 已经饱和的链路——正是本轮要消除的行为。这颗按钮做的是另一件事：把退避阶梯归零，再重新试
// 一次连接（登录请求本身就是最小的一次连通性探测）。
//
// 两步都要做。只归零不发请求在设备页 / 路由门闸上够用（那里挂着门闸，记录一抹就会重发），
// 但节点管理表压根没有门闸，抹掉记录之后不会有人替它重发。

import { Button } from '@vibeterm/ui/button';
import { Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { retryNodeLoginNow } from './node-login-retry';
import { ensureNodeLogin } from './session-key-store';

export interface NodeRetryConnectButtonProps {
  nodeId: string;
  nodeName?: string;
  className?: string;
  size?: 'sm' | 'default' | 'lg' | 'icon' | 'icon-xs';
}

/**
 * 用户主动重试：阶梯归零 + 重发一次静默登录。
 *
 * **不带 `allowPasskeyPrompt`**：这条路径上的失败是传输层的，弹系统仪式解决不了问题，
 * 只会在链路还没回来的时候惊吓用户。
 */
export function retryNodeConnection(nodeId: string): Promise<{ ok: boolean }> {
  retryNodeLoginNow(nodeId);
  return ensureNodeLogin(nodeId);
}

export function NodeRetryConnectButton({
  nodeId,
  nodeName,
  className,
  size = 'sm',
}: NodeRetryConnectButtonProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const onClick = useCallback(async () => {
    setPending(true);
    try {
      await retryNodeConnection(nodeId);
    } finally {
      if (alive.current) setPending(false);
    }
  }, [nodeId]);

  const label = t('auth.node.retryConnect');
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      className={className}
      disabled={pending}
      onClick={() => void onClick()}
      data-testid={`node-retry-connect-${nodeId}`}
      title={nodeName ? `${label} — ${nodeName}` : label}
    >
      {pending ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <RefreshCw />}
      {size !== 'icon' && size !== 'icon-xs' && <span className="truncate">{label}</span>}
    </Button>
  );
}

export default NodeRetryConnectButton;
