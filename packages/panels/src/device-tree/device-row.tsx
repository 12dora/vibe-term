import type { Device, TmuxPane, TmuxWindow } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { ChevronRight, Globe, GripVertical, Monitor, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DeviceConnectionAdapter } from '../device-connection';
import { DeviceStatusBadge } from '../device-status-badge';
import type { DeviceTreeNavigation, SidebarAgentAdapter } from './agent-adapter';
import { DeviceConnectionControl } from './device-connection-control';
import { SortableVerticalList, useSortableRow } from './device-tree-dnd';
import { WindowRow } from './window-row';

export interface DeviceRowProps {
  device: Device;
  windows: TmuxWindow[] | null;
  isExpanded: boolean;
  isOnline: boolean;
  isSelected: boolean;
  selectedWindowId?: string;
  selectedPaneId?: string;
  onExpandedChange: (deviceId: string, expanded: boolean) => void;
  onCreateWindow: (deviceId: string) => void;
  onCloseWindow: (deviceId: string, windowId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string) => void;
  onRenameWindow: (deviceId: string, windowId: string) => void;
  onRenamePane: (deviceId: string, paneId: string) => void;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  onWindowClick: (deviceId: string, windowId: string, panes: TmuxPane[]) => void;
  onWatchPane: (deviceId: string, paneId: string) => void;
  agent?: SidebarAgentAdapter;
  nav: DeviceTreeNavigation;
  /** 宿主连接管理；未传时不渲染连接开关，行为与内嵌宿主一致 */
  connection?: DeviceConnectionAdapter;
}

export function DeviceRow({
  device,
  windows,
  isExpanded,
  isOnline,
  isSelected,
  selectedWindowId,
  selectedPaneId,
  onExpandedChange,
  onCreateWindow,
  onCloseWindow,
  onClosePane,
  onRenameWindow,
  onRenamePane,
  onPaneClick,
  onWindowClick,
  onWatchPane,
  agent,
  nav,
  connection,
}: DeviceRowProps) {
  const { t } = useTranslation();
  const { stores } = useRuntime();
  const DeviceIcon = device.type === 'local' ? Monitor : Globe;
  const { setNodeRef, setDragHandleRef, style, isDragging, dragHandleProps } = useSortableRow(
    device.id
  );

  const status = connection?.status(device.id) ?? (isOnline ? 'connected' : 'disconnected');
  const isIntentionallyDisconnected = connection?.isIntentionallyDisconnected(device.id) ?? false;
  const showTree = isExpanded && !isIntentionallyDisconnected;

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`device-item-${device.id}`}
      className={cn(
        'group/device rounded-xl border border-border/60 overflow-hidden',
        isSelected ? 'bg-chat-surface' : 'bg-muted/20',
        isDragging && 'opacity-60 shadow-lg'
      )}
    >
      <div className="relative px-3 py-1.5">
        {isSelected && (
          <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-muted-foreground/70" />
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            ref={setDragHandleRef}
            {...dragHandleProps}
            aria-label={t('device.dragHandle')}
            onClick={(e) => e.stopPropagation()}
            className="touch-none cursor-grab shrink-0 -ml-1 text-muted-foreground/50 hover:text-muted-foreground opacity-100"
          >
            <GripVertical className="h-3.5 w-3.5 [@media(any-pointer:coarse)]:h-5 [@media(any-pointer:coarse)]:w-5" />
          </button>
          <DeviceIcon className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="flex-1 truncate text-xs font-medium">{device.name}</span>

          <DeviceStatusBadge deviceId={device.id} className="shrink-0" />
          <DeviceConnectionControl
            deviceId={device.id}
            status={status}
            connection={connection}
            onConnect={() => onExpandedChange(device.id, true)}
            onDisconnect={() => {
              connection?.disconnect(device.id);
              onExpandedChange(device.id, false);
            }}
          />
          <button
            type="button"
            data-testid={`device-expand-${device.id}`}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? t('common.collapse') : t('common.expand')}
            title={isExpanded ? t('common.collapse') : t('common.expand')}
            onClick={() => onExpandedChange(device.id, !isExpanded)}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:w-9"
          >
            <ChevronRight
              className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-90')}
            />
          </button>
        </div>
      </div>

      {showTree && (
        <div
          data-testid={`device-tree-${device.id}`}
          className="space-y-1.5 py-1.5 pr-1.5 pl-10 [@media(any-pointer:coarse)]:space-y-2"
        >
          {!windows && (
            <div className="text-xs text-muted-foreground px-2 py-1.5 text-center">
              {t('common.loading')}
            </div>
          )}

          {windows?.length === 0 && (
            <div className="text-xs text-muted-foreground px-2 py-1.5 text-center">
              {t('window.noWindows')}
            </div>
          )}

          {windows && windows.length > 0 && (
            <SortableVerticalList
              ids={windows.map((w) => w.id)}
              onReorder={(nextIds) => stores.tmux.getState().reorderWindows(device.id, nextIds)}
            >
              {windows.map((tmuxWindow) => (
                <WindowRow
                  key={tmuxWindow.id}
                  deviceId={device.id}
                  tmuxWindow={tmuxWindow}
                  isDeviceSelected={isSelected}
                  selectedWindowId={selectedWindowId}
                  selectedPaneId={selectedPaneId}
                  onPaneClick={onPaneClick}
                  onWindowClick={onWindowClick}
                  onCloseWindow={onCloseWindow}
                  onClosePane={onClosePane}
                  onRenameWindow={onRenameWindow}
                  onRenamePane={onRenamePane}
                  onWatchPane={onWatchPane}
                  agent={agent}
                  nav={nav}
                />
              ))}
            </SortableVerticalList>
          )}

          {/* New Window Button */}
          <button
            type="button"
            data-testid={`window-create-${device.id}`}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => onCreateWindow(device.id)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors text-muted-foreground hover:text-foreground hover:bg-accent/30 border border-dashed border-border/50 hover:border-border"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span className="text-xs">{t('window.new')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
