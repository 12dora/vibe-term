import { useBellStore } from '@tmex/notifications';
import type { TmuxPane } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { GripVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DeviceTreeNavigation, SidebarAgentAdapter } from './agent-adapter';
import { DeviceActionsMenu } from './device-actions-menu';
import { buildPaneActions } from './device-tree-actions';
import { useSortableRow } from './device-tree-dnd';
import { RowLabel, processSubtitle } from './row-label';

function PaneBellIcon({ paneId }: { paneId: string }) {
  const ringing = useBellStore((state) => Boolean(state.ringingPanes[paneId]));
  if (!ringing) return null;
  return <span className="bell-blink shrink-0">🔔 </span>;
}

export interface PaneRowProps {
  deviceId: string;
  windowId: string;
  pane: TmuxPane;
  isActive: boolean;
  isMobile: boolean;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string) => void;
  onRenamePane: (deviceId: string, paneId: string) => void;
  onWatchPane: (deviceId: string, paneId: string) => void;
  agent?: SidebarAgentAdapter;
  nav: DeviceTreeNavigation;
}

export function PaneRow({
  deviceId,
  windowId,
  pane,
  isActive,
  isMobile,
  onPaneClick,
  onClosePane,
  onRenamePane,
  onWatchPane,
  agent,
  nav,
}: PaneRowProps) {
  const { t } = useTranslation();
  const { stores, features } = useRuntime();
  const { setNodeRef, setDragHandleRef, style, isDragging, dragHandleProps } = useSortableRow(
    pane.id
  );

  const items = buildPaneActions({
    t,
    pane,
    watchUi: features.watchUi,
    onRename: () => onRenamePane(deviceId, pane.id),
    onCreateSession: agent
      ? () => agent.onCreateSessionForPane(nav, deviceId, windowId, pane)
      : undefined,
    onCreateWindowInCwd: (cwd) => stores.tmux.getState().createWindow(deviceId, undefined, cwd),
    onSplit: (paneId, direction, cwd) =>
      stores.tmux.getState().splitPane(deviceId, paneId, direction, cwd),
    onWatch: (paneId) => onWatchPane(deviceId, paneId),
    onClose: () => onClosePane(deviceId, windowId, pane.id),
  });

  return (
    <div ref={setNodeRef} style={style} className={cn(isDragging && 'opacity-60')}>
      {/* 菜单/关闭按钮的 absolute 锚点必须只包住 pane 行本身；
          若锚在外层（含 PaneSessionBranch），挂了 Agent session 后 top-1/2 会随容器撑高而错位 */}
      <div className="group/pane relative flex items-center gap-1">
        <button
          type="button"
          ref={setDragHandleRef}
          {...dragHandleProps}
          aria-label={t('window.dragHandlePane')}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'touch-none cursor-grab shrink-0 flex items-center justify-center text-muted-foreground/50 hover:text-muted-foreground opacity-100',
            isMobile
              ? 'h-9 w-4'
              : 'h-6 w-3 [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:w-4'
          )}
        >
          <GripVertical className={cn(isMobile ? 'h-4 w-4' : 'h-3 w-3')} />
        </button>
        <button
          type="button"
          onClick={() => onPaneClick(deviceId, windowId, pane.id)}
          data-testid={`pane-item-${pane.id}`}
          data-active={isActive ? 'true' : undefined}
          className={cn(
            'flex-1 min-w-0 flex items-center gap-2 px-2 py-1 rounded-lg text-left transition-colors pr-13 [@media(any-pointer:coarse)]:py-2 [@media(any-pointer:coarse)]:pr-21',
            isMobile && 'py-2.5 pr-24',
            isActive ? 'bg-primary/10 text-primary' : 'hover:bg-accent/30 text-muted-foreground'
          )}
        >
          <PaneBellIcon paneId={pane.id} />
          {/* 多 pane 窗口的窗口行不再展示细节，pane 行呈现完整的标题 + 进程@路径 */}
          <RowLabel
            title={pane.customName || pane.title || t('window.pane')}
            subtitle={processSubtitle(pane.currentCommand, pane.currentPath)}
          />
        </button>

        <DeviceActionsMenu
          triggerTestId={`pane-menu-${pane.id}`}
          triggerLabel={t('window.paneMenu')}
          triggerClassName={cn(
            isMobile
              ? 'h-11 w-11 right-11 rounded-lg bg-background/40 opacity-100'
              : 'h-5 w-5 right-7 [@media(any-pointer:coarse)]:h-10 [@media(any-pointer:coarse)]:w-10 [@media(any-pointer:coarse)]:right-10.5 [@media(any-pointer:coarse)]:rounded-lg',
            isActive
              ? 'opacity-100'
              : 'opacity-0 group-hover/pane:opacity-100 [@media(any-pointer:coarse)]:opacity-100'
          )}
          triggerIconClassName={cn(isMobile ? 'h-5 w-5' : 'h-3.5 w-3.5')}
          isMobile={isMobile}
          items={items}
        />

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClosePane(deviceId, windowId, pane.id);
          }}
          data-testid={`pane-close-${pane.id}`}
          className={cn(
            'absolute top-1/2 -translate-y-1/2 flex items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground transition-opacity',
            isMobile
              ? 'h-11 w-11 right-0 rounded-lg bg-background/40 opacity-100'
              : 'h-5 w-5 right-1.5 [@media(any-pointer:coarse)]:h-10 [@media(any-pointer:coarse)]:w-10 [@media(any-pointer:coarse)]:right-0.5 [@media(any-pointer:coarse)]:rounded-lg',
            isActive
              ? 'opacity-100'
              : 'opacity-0 group-hover/pane:opacity-100 [@media(any-pointer:coarse)]:opacity-100'
          )}
          title={t('window.closePane')}
        >
          <span className={cn('leading-none', isMobile ? 'text-base' : 'text-xs')}>×</span>
        </button>
      </div>

      {agent && <agent.PaneSessions nav={nav} deviceId={deviceId} paneId={pane.id} />}
    </div>
  );
}
