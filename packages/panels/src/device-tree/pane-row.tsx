import { useBellStore } from '@tmex/notifications';
import type { TmuxPane } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { GripVertical, Pencil, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DeviceTreeNavigation, SidebarAgentAdapter } from './agent-adapter';
import { type DeviceActionItem, DeviceActionsMenu } from './device-actions-menu';
import { buildSharedPaneActionItems } from './device-tree-actions';
import { useSortableRow } from './device-tree-dnd';

function PaneBellIcon({ paneId }: { paneId: string }) {
  const ringing = useBellStore((state) => Boolean(state.ringingPanes[paneId]));
  if (!ringing) return null;
  return <span className="bell-blink shrink-0">🔔 </span>;
}

function dragHandleClass(isMobile: boolean) {
  return cn(
    'touch-none cursor-grab shrink-0 flex items-center justify-center text-muted-foreground/50 hover:text-muted-foreground opacity-100',
    isMobile
      ? 'h-9 w-4'
      : 'h-6 w-3 [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:w-4'
  );
}

function dragHandleIconClass(isMobile: boolean) {
  return cn(isMobile ? 'h-4 w-4' : 'h-3 w-3');
}

function paneButtonClass(isMobile: boolean, isActive: boolean) {
  return cn(
    'flex-1 min-w-0 flex items-center gap-2 px-2 py-1 rounded-lg text-left transition-colors pr-13 [@media(any-pointer:coarse)]:py-2 [@media(any-pointer:coarse)]:pr-21',
    isMobile && 'py-2.5 pr-24',
    isActive ? 'bg-primary/10 text-primary' : 'hover:bg-accent/30 text-muted-foreground'
  );
}

function menuTriggerClass(isMobile: boolean, isActive: boolean) {
  return cn(
    isMobile
      ? 'h-11 w-11 right-11 rounded-lg bg-background/40 opacity-100'
      : 'h-5 w-5 right-7 [@media(any-pointer:coarse)]:h-10 [@media(any-pointer:coarse)]:w-10 [@media(any-pointer:coarse)]:right-10.5 [@media(any-pointer:coarse)]:rounded-lg',
    isActive
      ? 'opacity-100'
      : 'opacity-0 group-hover/pane:opacity-100 [@media(any-pointer:coarse)]:opacity-100'
  );
}

function closeButtonClass(isMobile: boolean, isActive: boolean) {
  return cn(
    'absolute top-1/2 -translate-y-1/2 flex items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground transition-opacity',
    isMobile
      ? 'h-11 w-11 right-0 rounded-lg bg-background/40 opacity-100'
      : 'h-5 w-5 right-1.5 [@media(any-pointer:coarse)]:h-10 [@media(any-pointer:coarse)]:w-10 [@media(any-pointer:coarse)]:right-0.5 [@media(any-pointer:coarse)]:rounded-lg',
    isActive
      ? 'opacity-100'
      : 'opacity-0 group-hover/pane:opacity-100 [@media(any-pointer:coarse)]:opacity-100'
  );
}

/** 多 pane 窗口的窗口行不再展示细节，pane 行呈现完整的标题 + 进程@路径 */
function PaneRowLabel({ pane }: { pane: TmuxPane }) {
  const { t } = useTranslation();
  return (
    <span className="flex-1 min-w-0">
      <span className="font-mono text-[11px] leading-tight font-medium line-clamp-2 [overflow-wrap:break-word]">
        {pane.customName || pane.title || t('window.pane')}
      </span>
      {pane.currentCommand && (
        <span className="font-mono text-[10.5px] leading-tight text-muted-foreground line-clamp-1 break-all">
          {pane.currentPath ? `${pane.currentCommand}@${pane.currentPath}` : pane.currentCommand}
        </span>
      )}
    </span>
  );
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

  const items: DeviceActionItem[] = [
    {
      key: 'rename',
      testId: `pane-menu-rename-${pane.id}`,
      icon: Pencil,
      label: t('window.rename'),
      onSelect: () => onRenamePane(deviceId, pane.id),
    },
    ...buildSharedPaneActionItems({
      deviceId,
      windowId,
      pane,
      sessionPane: pane,
      agent,
      nav,
      watchUi: features.watchUi,
      testIds: {
        newSession: `pane-menu-new-session-${pane.id}`,
        splitRight: `pane-split-right-${pane.id}`,
        splitDown: `pane-split-down-${pane.id}`,
        watch: `pane-watch-${pane.id}`,
      },
      t,
      createWindow: (id, name, cwd) => stores.tmux.getState().createWindow(id, name, cwd),
      splitPane: (id, paneId, direction, cwd) =>
        stores.tmux.getState().splitPane(id, paneId, direction, cwd),
      onWatchPane,
    }),
    {
      key: 'close',
      testId: `pane-menu-close-${pane.id}`,
      icon: X,
      label: t('window.closePane'),
      destructive: true,
      onSelect: () => onClosePane(deviceId, windowId, pane.id),
    },
  ];

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
          className={dragHandleClass(isMobile)}
        >
          <GripVertical className={dragHandleIconClass(isMobile)} />
        </button>
        <button
          type="button"
          onClick={() => onPaneClick(deviceId, windowId, pane.id)}
          data-testid={`pane-item-${pane.id}`}
          data-active={isActive ? 'true' : undefined}
          className={paneButtonClass(isMobile, isActive)}
        >
          <PaneBellIcon paneId={pane.id} />
          <PaneRowLabel pane={pane} />
        </button>

        <DeviceActionsMenu
          triggerTestId={`pane-menu-${pane.id}`}
          triggerLabel={t('window.paneMenu')}
          triggerClassName={menuTriggerClass(isMobile, isActive)}
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
          className={closeButtonClass(isMobile, isActive)}
          title={t('window.closePane')}
        >
          <span className={cn('leading-none', isMobile ? 'text-base' : 'text-xs')}>×</span>
        </button>
      </div>

      {agent && <agent.PaneSessions nav={nav} deviceId={deviceId} paneId={pane.id} />}
    </div>
  );
}
