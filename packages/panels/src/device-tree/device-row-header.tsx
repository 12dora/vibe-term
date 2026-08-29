import { cn } from '@tmex/ui';
import { ChevronRight, Globe, GripVertical, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DeviceConnectionStatus } from '../device-connection';
import { DeviceStatusBadge } from '../device-status-badge';
import { DeviceConnectionControl } from './device-connection-control';
import type { SortableRow } from './device-tree-dnd';
import type { DeviceRowProps } from './device-tree-row-props';

export interface DeviceRowHeaderProps extends DeviceRowProps {
  sortable: SortableRow;
  status: DeviceConnectionStatus;
}

/** 设备行标题条：拖拽手柄 + 名称 + 状态徽标 + 连接状态点 + 展开箭头 */
export function DeviceRowHeader({
  device,
  isExpanded,
  isSelected,
  onExpandedChange,
  sortable,
  status,
}: DeviceRowHeaderProps) {
  const { t } = useTranslation();
  const deviceId = device.id;
  const DeviceIcon = device.type === 'local' ? Monitor : Globe;

  return (
    <div className="relative px-3 py-1.5">
      {isSelected && (
        <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-muted-foreground/70" />
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          ref={sortable.setDragHandleRef}
          {...sortable.dragHandleProps}
          aria-label={t('device.dragHandle')}
          onClick={(e) => e.stopPropagation()}
          className="touch-none cursor-grab shrink-0 -ml-1 text-muted-foreground/50 hover:text-muted-foreground opacity-100"
        >
          <GripVertical className="h-3.5 w-3.5 [@media(any-pointer:coarse)]:h-5 [@media(any-pointer:coarse)]:w-5" />
        </button>
        <DeviceIcon className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="flex-1 truncate text-xs font-medium">{device.name}</span>

        <DeviceStatusBadge deviceId={deviceId} className="shrink-0" />
        <DeviceConnectionControl deviceId={deviceId} status={status} />
        <button
          type="button"
          data-testid={`device-expand-${deviceId}`}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? t('common.collapse') : t('common.expand')}
          title={isExpanded ? t('common.collapse') : t('common.expand')}
          onClick={() => onExpandedChange(deviceId, !isExpanded)}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:w-9"
        >
          <ChevronRight
            className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-90')}
          />
        </button>
      </div>
    </div>
  );
}
