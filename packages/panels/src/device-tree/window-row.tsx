import { useBellStore } from '@tmex/notifications';
import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import { buildWindowTitleParts } from '@tmex/stores';
import { useRuntime } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { useSidebar } from '@tmex/ui/sidebar';
import { GripVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DeviceTreeNavigation, SidebarAgentAdapter } from './agent-adapter';
import { DeviceActionsMenu } from './device-actions-menu';
import { buildWindowActions } from './device-tree-actions';
import { SortableVerticalList, useSortableRow } from './device-tree-dnd';
import { pickActivePane } from './device-tree-navigation';
import { PaneRow } from './pane-row';
import { RowLabel, processSubtitle } from './row-label';

function WindowBellIcon({ paneIds }: { paneIds: string[] }) {
  const ringing = useBellStore((state) => paneIds.some((id) => state.ringingPanes[id]));
  if (!ringing) return null;
  return <span className="bell-blink shrink-0">🔔 </span>;
}

export interface WindowRowProps {
  deviceId: string;
  tmuxWindow: TmuxWindow;
  isDeviceSelected: boolean;
  selectedWindowId?: string;
  selectedPaneId?: string;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  onWindowClick: (deviceId: string, windowId: string, panes: TmuxPane[]) => void;
  onCloseWindow: (deviceId: string, windowId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string) => void;
  onRenameWindow: (deviceId: string, windowId: string) => void;
  onRenamePane: (deviceId: string, paneId: string) => void;
  onWatchPane: (deviceId: string, paneId: string) => void;
  agent?: SidebarAgentAdapter;
  nav: DeviceTreeNavigation;
}

export function WindowRow({
  deviceId,
  tmuxWindow,
  isDeviceSelected,
  selectedWindowId,
  selectedPaneId,
  onPaneClick,
  onWindowClick,
  onCloseWindow,
  onClosePane,
  onRenameWindow,
  onRenamePane,
  onWatchPane,
  agent,
  nav,
}: WindowRowProps) {
  const { t } = useTranslation();
  const { isMobile } = useSidebar();
  const { stores, features } = useRuntime();
  const hasMultiplePanes = tmuxWindow.panes.length > 1;
  const titleParts = buildWindowTitleParts(tmuxWindow);
  const activePane = pickActivePane(tmuxWindow.panes);

  const selectedPaneInWindow = tmuxWindow.panes.find((pane) => pane.id === selectedPaneId);
  const isPaneSelected =
    isDeviceSelected && tmuxWindow.id === selectedWindowId && Boolean(selectedPaneInWindow);

  const { setNodeRef, setDragHandleRef, style, isDragging, dragHandleProps } = useSortableRow(
    tmuxWindow.id
  );

  // 零 pane 的窗口（快照到达前的中间态）没有可挂 agent 会话的目标，菜单项必须整条消失
  const sessionTargetPane = selectedPaneInWindow ?? tmuxWindow.panes[0];
  const items = buildWindowActions({
    t,
    tmuxWindow,
    watchUi: features.watchUi,
    onRename: () => onRenameWindow(deviceId, tmuxWindow.id),
    onCreateSession:
      agent && sessionTargetPane
        ? () => agent.onCreateSessionForPane(nav, deviceId, tmuxWindow.id, sessionTargetPane)
        : undefined,
    onCreateWindowInCwd: (cwd) => stores.tmux.getState().createWindow(deviceId, undefined, cwd),
    onSplit: (paneId, direction, cwd) =>
      stores.tmux.getState().splitPane(deviceId, paneId, direction, cwd),
    onWatch: (paneId) => onWatchPane(deviceId, paneId),
    onClose: () => onCloseWindow(deviceId, tmuxWindow.id),
  });

  return (
    <div ref={setNodeRef} style={style} className={cn('space-y-1', isDragging && 'opacity-60')}>
      {/* Window Header - Clickable */}
      <div className="group relative flex items-center gap-1">
        <button
          type="button"
          ref={setDragHandleRef}
          {...dragHandleProps}
          aria-label={t('window.dragHandle')}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'touch-none cursor-grab shrink-0 flex items-center justify-center text-muted-foreground/50 hover:text-muted-foreground opacity-100',
            isMobile
              ? 'h-9 w-4'
              : 'h-6 w-3.5 [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:w-4'
          )}
        >
          <GripVertical className={cn(isMobile ? 'h-4 w-4' : 'h-3.5 w-3.5')} />
        </button>
        <button
          type="button"
          onClick={() => onWindowClick(deviceId, tmuxWindow.id, tmuxWindow.panes)}
          data-testid={`window-item-${tmuxWindow.id}`}
          data-active={isPaneSelected ? 'true' : undefined}
          className={cn(
            'flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors pr-7 [@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:pr-12',
            isMobile && 'py-2.5 pr-13',
            isPaneSelected ? 'bg-primary/10 text-primary' : 'hover:bg-accent/50 text-foreground'
          )}
        >
          <WindowBellIcon paneIds={tmuxWindow.panes.map((p) => p.id)} />

          {hasMultiplePanes ? (
            // 多 pane 窗口：窗口行只做分组标识，标题/进程细节由各 pane 行完整呈现
            <span className="flex-1 min-w-0 font-mono text-[10.5px] leading-tight text-muted-foreground">
              {t('window.paneCount', { count: tmuxWindow.panes.length })}
            </span>
          ) : (
            <RowLabel
              title={titleParts.title}
              subtitle={processSubtitle(titleParts.processName, activePane?.currentPath)}
            />
          )}
        </button>

        {/* Window Actions Menu - positioned absolutely；多 pane 窗口的操作全部下放到各 pane 行 */}
        {!hasMultiplePanes && (
          <DeviceActionsMenu
            triggerTestId={`window-menu-${tmuxWindow.id}`}
            triggerLabel={t('window.menu')}
            triggerTitle={t('window.menu')}
            triggerClassName={cn(
              isMobile
                ? 'h-11 w-11 right-0 rounded-lg bg-background/40 opacity-100'
                : 'h-5 w-5 right-1.5 [@media(any-pointer:coarse)]:h-10 [@media(any-pointer:coarse)]:w-10 [@media(any-pointer:coarse)]:right-0.5 [@media(any-pointer:coarse)]:rounded-lg',
              isPaneSelected
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 [@media(any-pointer:coarse)]:opacity-100'
            )}
            triggerIconClassName={cn(
              isMobile
                ? 'h-5 w-5'
                : 'h-3.5 w-3.5 [@media(any-pointer:coarse)]:h-4.5 [@media(any-pointer:coarse)]:w-4.5'
            )}
            isMobile={isMobile}
            items={items}
          />
        )}
      </div>

      {/* Panes List - Only show if window has multiple panes */}
      {hasMultiplePanes && (
        <div className="ml-4 pl-2 border-l border-border/50 space-y-1 [@media(any-pointer:coarse)]:space-y-1.5">
          <SortableVerticalList
            ids={tmuxWindow.panes.map((p) => p.id)}
            onReorder={(nextIds) =>
              stores.tmux.getState().reorderPanes(deviceId, tmuxWindow.id, nextIds)
            }
          >
            {tmuxWindow.panes.map((pane) => (
              <PaneRow
                key={pane.id}
                deviceId={deviceId}
                windowId={tmuxWindow.id}
                pane={pane}
                isActive={isPaneSelected && pane.id === selectedPaneId}
                isMobile={isMobile}
                onPaneClick={onPaneClick}
                onClosePane={onClosePane}
                onRenamePane={onRenamePane}
                onWatchPane={onWatchPane}
                agent={agent}
                nav={nav}
              />
            ))}
          </SortableVerticalList>
        </div>
      )}

      {/* 单 pane 窗口不渲染 pane 列表，会话挂在窗口节点下 */}
      {!hasMultiplePanes && tmuxWindow.panes[0] && agent && (
        <div className="ml-[36px] pl-2 border-l border-border/50">
          <agent.PaneSessions nav={nav} deviceId={deviceId} paneId={tmuxWindow.panes[0].id} />
        </div>
      )}
    </div>
  );
}
