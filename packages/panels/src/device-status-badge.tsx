import { useTmuxStore } from '@vibeterm/stores/react';
import { cn } from '@vibeterm/ui';
import { Badge } from '@vibeterm/ui/badge';
import { AlertCircle, RefreshCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { buildDeviceErrorBadge } from './device-status-badge-model';

const TONE_CLASS = {
  error: 'border-red-400/40 bg-red-500/10 text-red-700 dark:text-red-300',
  warning: 'border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
} as const;

interface DeviceStatusBadgeProps {
  deviceId: string;
  className?: string;
}

export function DeviceStatusBadge({ deviceId, className }: DeviceStatusBadgeProps) {
  const { t } = useTranslation();
  const reconnecting = useTmuxStore((state) => state.deviceReconnecting[deviceId]);
  const error = useTmuxStore((state) => state.deviceErrors[deviceId]);

  if (reconnecting) {
    return (
      <Badge
        variant="outline"
        title={reconnecting.message}
        className={cn(
          'h-5 gap-1 border-amber-400/40 bg-amber-500/10 px-1.5 text-[10px] font-normal text-amber-700 dark:text-amber-300',
          className
        )}
      >
        <RefreshCcw className="h-3 w-3 animate-spin motion-reduce:animate-none" />
        <span className="truncate max-w-[120px]">{reconnecting.message}</span>
      </Badge>
    );
  }

  if (error) {
    const { label, tooltip, tone } = buildDeviceErrorBadge(error, (key) => t(key as any));

    return (
      <Badge
        variant="outline"
        title={tooltip}
        className={cn('h-5 gap-1 px-1.5 text-[10px] font-normal', TONE_CLASS[tone], className)}
      >
        <AlertCircle className="h-3 w-3" />
        <span className="truncate max-w-[120px]">{label}</span>
      </Badge>
    );
  }

  return null;
}
