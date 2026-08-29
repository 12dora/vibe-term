// 卡片主按钮：真实的连接/断开开关，由宿主注入的 DeviceConnectionAdapter 驱动。
// 点「连接」会顺带清掉持久化的「断开意图」（见 adapter 实现），所以这里只做状态映射。
//
// 节点离线时（`offline`）：store 里残留的 connected / connecting / reconnecting 都不可信，
// 一律按「已断开」展示，让用户能点「连接」发起一次手动尝试；只有掉线之后用户自己点出来的
// 尝试才照常展示 connecting / error / reconnecting（节点恢复在线时复位）。

import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceConnectionAdapter, DeviceConnectionStatus } from '../device-connection';
import { deviceStatusDotClass } from '../device-tree/device-connection-control';

export type DeviceConnectAction = 'connect' | 'disconnect' | 'pending';

export function deviceConnectAction(status: DeviceConnectionStatus): DeviceConnectAction {
  switch (status) {
    case 'connected':
      return 'disconnect';
    case 'connecting':
    case 'disconnecting':
    case 'reconnecting':
      return 'pending';
    default:
      return 'connect';
  }
}

/**
 * 节点离线时的展示状态：没有用户在掉线后发起的尝试时一律 disconnected（按钮可点）；
 * 有尝试时残留的 connected 仍视为 disconnected，其余（connecting / error / reconnecting）照旧。
 */
export function displayedConnectionStatus(
  status: DeviceConnectionStatus,
  offline: boolean,
  attemptedWhileOffline = false
): DeviceConnectionStatus {
  if (!offline) return status;
  if (!attemptedWhileOffline) return 'disconnected';
  return status === 'connected' ? 'disconnected' : status;
}

export interface DeviceCardConnectToggleProps {
  deviceId: string;
  connection: DeviceConnectionAdapter;
  offline?: boolean;
}

export function DeviceCardConnectToggle({
  deviceId,
  connection,
  offline = false,
}: DeviceCardConnectToggleProps) {
  const { t } = useTranslation();
  const [attemptedWhileOffline, setAttemptedWhileOffline] = useState(false);
  useEffect(() => {
    if (!offline) setAttemptedWhileOffline(false);
  }, [offline]);
  const status = displayedConnectionStatus(
    connection.status(deviceId),
    offline,
    attemptedWhileOffline
  );
  const action = deviceConnectAction(status);
  const label =
    action === 'disconnect'
      ? t('device.disconnect')
      : status === 'disconnecting'
        ? t('device.disconnecting')
        : action === 'pending'
          ? t('device.connecting')
          : t('device.connect');

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      // 宽度贴内容：固定最小宽度会在按钮右侧留下一大块空白，把名称挤没
      className="shrink-0 justify-center"
      data-testid={`device-card-connect-${deviceId}`}
      data-state={status}
      data-action={action}
      disabled={action === 'pending'}
      title={label}
      onClick={() => {
        if (action === 'disconnect') {
          connection.disconnect(deviceId);
          return;
        }
        if (action === 'connect') {
          if (offline) setAttemptedWhileOffline(true);
          connection.connect(deviceId);
        }
      }}
    >
      {action === 'pending' ? (
        <Loader2
          aria-hidden="true"
          className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
        />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            'h-2 w-2 shrink-0 rounded-full transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none',
            deviceStatusDotClass(status)
          )}
        />
      )}
      <span className="truncate">{label}</span>
    </Button>
  );
}
