// 设备行的连接状态指示：只有一个状态圆点，连接/断开由展开态与宿主自行驱动。

import { cn } from '@tmex/ui';
import { useTranslation } from 'react-i18next';
import type { DeviceConnectionStatus } from '../device-connection';

export function deviceStatusDotClass(status: DeviceConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'bg-emerald-500';
    case 'connecting':
    case 'reconnecting':
    case 'error':
      return 'bg-amber-500';
    default:
      return 'bg-gray-400';
  }
}

export interface DeviceConnectionControlProps {
  deviceId: string;
  status: DeviceConnectionStatus;
}

export function DeviceConnectionControl({ deviceId, status }: DeviceConnectionControlProps) {
  const { t } = useTranslation();
  const statusLabel =
    status === 'connected'
      ? t('device.connected')
      : status === 'connecting' || status === 'reconnecting'
        ? t('device.connecting')
        : t('device.disconnected');

  return (
    <span
      data-testid={`device-online-status-${deviceId}`}
      data-status={status}
      data-online={status === 'connected'}
      aria-label={statusLabel}
      title={statusLabel}
      className={cn(
        'h-2 w-2 shrink-0 rounded-full transition-colors duration-(--tmex-motion-standard) ease-out motion-reduce:transition-none',
        deviceStatusDotClass(status)
      )}
    />
  );
}
