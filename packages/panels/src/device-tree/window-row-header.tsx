import { useBellStore } from '@tmex/notifications';
import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import { buildWindowTitleParts } from '@tmex/stores';
import { cn } from '@tmex/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { DeviceActionsMenu } from './device-actions-menu';
import type { WindowRowProps } from './device-tree-row-props';
import { rowActionVisibilityClass } from './device-tree-row-shell';
import { RowLabel, processSubtitle } from './row-label';
import { useWindowActionItems } from './use-row-action-items';

function WindowBellIcon({ paneIds }: { paneIds: readonly string[] }) {
  const ringing = useBellStore((state) => paneIds.some((id) => state.ringingPanes[id]));
  if (!ringing) return null;
  return <span className="bell-blink shrink-0">🔔 </span>;
}

export interface WindowRowHeaderProps {
  tmuxWindow: TmuxWindow;
  paneIds: readonly string[];
  activePane?: TmuxPane;
  hasMultiplePanes: boolean;
  isPaneSelected: boolean;
  isMobile: boolean;
  onClick: () => void;
}

/** 窗口行的可点击主体：铃铛 + 标题（多 pane 窗口退化成分组计数） */
export const WindowRowHeader = memo(function WindowRowHeader({
  tmuxWindow,
  paneIds,
  activePane,
  hasMultiplePanes,
  isPaneSelected,
  isMobile,
  onClick,
}: WindowRowHeaderProps) {
  const { t } = useTranslation();
  const titleParts = buildWindowTitleParts(tmuxWindow);

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`window-item-${tmuxWindow.id}`}
      data-active={isPaneSelected ? 'true' : undefined}
      className={cn(
        'flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none pr-7 [@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:pr-12',
        isMobile && 'py-2.5 pr-13',
        isPaneSelected ? 'bg-primary/10 text-primary' : 'hover:bg-accent/50 text-foreground'
      )}
    >
      <WindowBellIcon paneIds={paneIds} />

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
  );
});

export interface WindowRowMenuProps extends WindowRowProps {
  isPaneSelected: boolean;
  isMobile: boolean;
}

/** 窗口行操作菜单；多 pane 窗口不渲染，操作全部下放到各 pane 行 */
export function WindowRowMenu(props: WindowRowMenuProps) {
  const { t } = useTranslation();
  const { tmuxWindow, isPaneSelected, isMobile } = props;
  const items = useWindowActionItems(props);

  return (
    <DeviceActionsMenu
      triggerTestId={`window-menu-${tmuxWindow.id}`}
      triggerLabel={t('window.menu')}
      triggerTitle={t('window.menu')}
      triggerClassName={cn(
        isMobile
          ? 'h-11 w-11 right-0 rounded-lg bg-background/40 opacity-100'
          : 'h-5 w-5 right-1.5 [@media(any-pointer:coarse)]:h-10 [@media(any-pointer:coarse)]:w-10 [@media(any-pointer:coarse)]:right-0.5 [@media(any-pointer:coarse)]:rounded-lg',
        rowActionVisibilityClass(isPaneSelected, 'group-hover:opacity-100')
      )}
      triggerIconClassName={cn(
        isMobile
          ? 'h-5 w-5'
          : 'h-3.5 w-3.5 [@media(any-pointer:coarse)]:h-4.5 [@media(any-pointer:coarse)]:w-4.5'
      )}
      isMobile={isMobile}
      items={items}
    />
  );
}
