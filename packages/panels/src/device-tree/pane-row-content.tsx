import { useBellStore } from '@tmex/notifications';
import type { TmuxPane } from '@tmex/shared';
import { cn } from '@tmex/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { DeviceActionsMenu } from './device-actions-menu';
import type { PaneRowProps } from './device-tree-row-props';
import { rowActionVisibilityClass } from './device-tree-row-shell';
import { RowLabel, processSubtitle } from './row-label';
import { usePaneActionItems } from './use-row-action-items';

const PANE_GROUP_HOVER = 'group-hover/pane:opacity-100';

function PaneBellIcon({ paneId }: { paneId: string }) {
  const ringing = useBellStore((state) => Boolean(state.ringingPanes[paneId]));
  if (!ringing) return null;
  return <span className="bell-blink shrink-0">🔔 </span>;
}

export interface PaneRowContentProps {
  pane: TmuxPane;
  isActive: boolean;
  isMobile: boolean;
  onClick: () => void;
}

/** pane 行的可点击主体：多 pane 窗口的窗口行不展示细节，这里呈现完整的标题 + 进程@路径 */
export const PaneRowContent = memo(function PaneRowContent({
  pane,
  isActive,
  isMobile,
  onClick,
}: PaneRowContentProps) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`pane-item-${pane.id}`}
      data-active={isActive ? 'true' : undefined}
      className={cn(
        'flex-1 min-w-0 flex items-center gap-2 px-2 py-1 rounded-lg text-left transition-colors pr-13 [@media(any-pointer:coarse)]:py-2 [@media(any-pointer:coarse)]:pr-21',
        isMobile && 'py-2.5 pr-24',
        isActive ? 'bg-primary/10 text-primary' : 'hover:bg-accent/30 text-muted-foreground'
      )}
    >
      <PaneBellIcon paneId={pane.id} />
      <RowLabel
        title={pane.customName || pane.title || t('window.pane')}
        subtitle={processSubtitle(pane.currentCommand, pane.currentPath)}
      />
    </button>
  );
});

/** pane 行尾的操作区：下拉菜单 + 关闭按钮 */
export function PaneRowActions(props: PaneRowProps) {
  const { pane, isActive, isMobile } = props;
  const { t } = useTranslation();
  const items = usePaneActionItems(props);
  const visibility = rowActionVisibilityClass(isActive, PANE_GROUP_HOVER);

  return (
    <>
      <DeviceActionsMenu
        triggerTestId={`pane-menu-${pane.id}`}
        triggerLabel={t('window.paneMenu')}
        triggerClassName={cn(
          isMobile
            ? 'h-11 w-11 right-11 rounded-lg bg-background/40 opacity-100'
            : 'h-5 w-5 right-7 [@media(any-pointer:coarse)]:h-10 [@media(any-pointer:coarse)]:w-10 [@media(any-pointer:coarse)]:right-10.5 [@media(any-pointer:coarse)]:rounded-lg',
          visibility
        )}
        triggerIconClassName={cn(isMobile ? 'h-5 w-5' : 'h-3.5 w-3.5')}
        isMobile={isMobile}
        items={items}
      />
      <PaneCloseButton {...props} visibility={visibility} />
    </>
  );
}

function PaneCloseButton({
  deviceId,
  windowId,
  pane,
  isMobile,
  onClosePane,
  visibility,
}: PaneRowProps & { visibility: string }) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClosePane(deviceId, windowId, pane.id);
      }}
      data-testid={`pane-close-${pane.id}`}
      className={cn(
        'absolute top-1/2 -translate-y-1/2 flex items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground transition-opacity duration-(--tmex-motion-standard) ease-out motion-reduce:transition-none',
        isMobile
          ? 'h-11 w-11 right-0 rounded-lg bg-background/40 opacity-100'
          : 'h-5 w-5 right-1.5 [@media(any-pointer:coarse)]:h-10 [@media(any-pointer:coarse)]:w-10 [@media(any-pointer:coarse)]:right-0.5 [@media(any-pointer:coarse)]:rounded-lg',
        visibility
      )}
      title={t('window.closePane')}
    >
      <span className={cn('leading-none', isMobile ? 'text-base' : 'text-xs')}>×</span>
    </button>
  );
}
