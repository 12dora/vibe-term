import { cn } from '@tmex/ui';
import { Collapsible, CollapsibleContent } from '@tmex/ui/collapsible';
import { memo } from 'react';
import { DeviceRowHeader } from './device-row-header';
import { useSortableRow } from './device-tree-dnd';
import type { DeviceRowProps } from './device-tree-row-props';
import { useDeviceOnline, useDeviceWindows } from './device-tree-selectors';
import { DeviceWindowList } from './device-window-list';

export type { DeviceRowProps };

export const DeviceRow = memo(function DeviceRow(props: DeviceRowProps) {
  const { device, isExpanded, isSelected, connection } = props;
  const deviceId = device.id;
  const sortable = useSortableRow(deviceId);

  // 只订阅本设备的切片：别的设备推快照/改连接态时这一行不会重渲染
  const windows = useDeviceWindows(deviceId);
  const isOnline = useDeviceOnline(deviceId);

  const status = connection?.status(deviceId) ?? (isOnline ? 'connected' : 'disconnected');
  const isIntentionallyDisconnected = connection?.isIntentionallyDisconnected(deviceId) ?? false;
  const showTree = isExpanded && !isIntentionallyDisconnected;

  return (
    <div
      ref={sortable.setNodeRef}
      style={sortable.style}
      data-testid={`device-item-${deviceId}`}
      className={cn(
        'group/device rounded-xl border border-border/60 overflow-hidden transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none',
        isSelected ? 'bg-chat-surface' : 'bg-muted/20',
        sortable.isDragging && 'opacity-60 shadow-lg'
      )}
    >
      <DeviceRowHeader {...props} sortable={sortable} status={status} />
      {/* 受控 Collapsible：展开/收起都走高度+透明度过渡；首屏已展开的设备由 Base UI
          自己取消入场过渡（不会从 0 高度弹一下），收起时面板走完过渡才卸载 */}
      <Collapsible open={showTree}>
        <CollapsibleContent>
          <DeviceWindowList {...props} windows={windows} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
});
