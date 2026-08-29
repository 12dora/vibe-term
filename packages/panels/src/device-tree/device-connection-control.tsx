// 设备行的连接指示与开关：状态圆点 + Power 按钮。宿主未提供 connection 时只渲染圆点。

import { cn } from '@tmex/ui';
import { Power } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DeviceConnectionAdapter, DeviceConnectionStatus } from '../device-connection';

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

export function deviceConnectionAction(status: DeviceConnectionStatus): 'connect' | 'disconnect' {
  switch (status) {
    case 'connected':
    case 'connecting':
    case 'reconnecting':
      return 'disconnect';
    default:
      return 'connect';
  }
}

export interface DeviceConnectionControlProps {
  deviceId: string;
  status: DeviceConnectionStatus;
  connection?: DeviceConnectionAdapter;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function DeviceConnectionControl({
  deviceId,
  status,
  connection,
  onConnect,
  onDisconnect,
}: DeviceConnectionControlProps) {
  const { t } = useTranslation();
  const action = deviceConnectionAction(status);
  const actionLabel = action === 'disconnect' ? t('device.disconnect') : t('device.connect');
  const statusLabel =
    status === 'connected'
      ? t('device.connected')
      : status === 'connecting' || status === 'reconnecting'
        ? t('device.connecting')
        : t('device.disconnected');

  return (
    <>
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
      {connection && (
        <button
          type="button"
          data-testid={`device-${action}-${deviceId}`}
          aria-label={actionLabel}
          title={actionLabel}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (action === 'disconnect') {
              onDisconnect();
            } else {
              onConnect();
            }
          }}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--tmex-motion-fast) ease-out hover:bg-accent hover:text-foreground motion-reduce:transition-none [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:w-9"
        >
          <Power
            className={cn(
              'h-3.5 w-3.5 transition-colors duration-(--tmex-motion-standard) ease-out motion-reduce:transition-none',
              action === 'disconnect' ? 'text-emerald-500' : 'text-muted-foreground'
            )}
          />
        </button>
      )}
    </>
  );
}
