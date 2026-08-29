// 卡片主按钮：真实的连接/断开开关，由宿主注入的 DeviceConnectionAdapter 驱动。
// 点「连接」会顺带清掉持久化的「断开意图」（见 adapter 实现），所以这里只做状态映射。

import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { useTranslation } from 'react-i18next';
import type { DeviceConnectionAdapter, DeviceConnectionStatus } from '../device-connection';
import { deviceStatusDotClass } from '../device-tree/device-connection-control';

export type DeviceConnectAction = 'connect' | 'disconnect' | 'pending';

export function deviceConnectAction(status: DeviceConnectionStatus): DeviceConnectAction {
  switch (status) {
    case 'connected':
      return 'disconnect';
    case 'connecting':
    case 'reconnecting':
      return 'pending';
    default:
      return 'connect';
  }
}

export interface DeviceCardConnectToggleProps {
  deviceId: string;
  connection: DeviceConnectionAdapter;
}

export function DeviceCardConnectToggle({ deviceId, connection }: DeviceCardConnectToggleProps) {
  const { t } = useTranslation();
  const status = connection.status(deviceId);
  const action = deviceConnectAction(status);
  const label =
    action === 'disconnect'
      ? t('device.disconnect')
      : action === 'pending'
        ? t('device.connecting')
        : t('device.connect');

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
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
          connection.connect(deviceId);
        }
      }}
    >
      <span
        aria-hidden="true"
        className={cn(
          'h-2 w-2 shrink-0 rounded-full transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none',
          deviceStatusDotClass(status)
        )}
      />
      {label}
    </Button>
  );
}
