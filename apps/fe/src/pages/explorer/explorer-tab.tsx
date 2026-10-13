// 标签栏里的一个标签页：节点在线点 + 可选的节点名前缀 + 标题 + 关闭按钮，自带右键菜单与拖拽。

import type { DialogNodeOption } from '@/pages/devices/dialog-nodes';
import type { ExplorerTab } from '@vibeterm/stores';
import { explorerTabPath } from '@vibeterm/stores/explorer';
import { cn } from '@vibeterm/ui';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@vibeterm/ui/context-menu';
import { X } from 'lucide-react';
import { type DragEvent, type KeyboardEvent, type MouseEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EXPLORER_TAB_MIME, setDraggedTabId } from './tab-dnd';
import { tabLabel, tabTitle } from './tab-label';
import { useTabFileDrop } from './use-tab-file-drop';
import { useTabRoot } from './use-tab-root';
import { useWorkspaceActions } from './workspace-actions';

export interface ExplorerTabItemProps {
  tab: ExplorerTab;
  active: boolean;
  /** 节点列表里查不到（已移除或还没加载完）时为 undefined */
  node: DialogNodeOption | undefined;
  /** 工作区里有多个节点的标签页时才显示节点名前缀 */
  showNode: boolean;
  /** 本次挂载是新开的标签页（播放入场动画） */
  isNew: boolean;
  /** 还能再分栏 */
  canSplit: boolean;
  /** 所在分栏只有这一个标签页 */
  onlyTab: boolean;
  /** 所在分栏的 id；只有一个分栏时为 null（不出「关闭分栏」） */
  closablePaneId: string | null;
  /** 能否拖动重排（窄屏合并栏里不行） */
  draggable: boolean;
  /** 方向键在标签页之间移动 */
  onArrow(tabId: string, delta: -1 | 1): void;
}

const TAB_CLASS =
  'group/tab relative flex h-full max-w-56 cursor-default select-none items-center gap-1.5 border-r border-border/50 pr-1 pl-2.5 text-xs outline-none transition-colors duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset';

const CLOSE_CLASS =
  'inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 outline-none transition-[opacity,color,background-color] duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100';

function TabMenuItems({ tab, canSplit, onlyTab, closablePaneId }: ExplorerTabItemProps) {
  const { t } = useTranslation();
  const actions = useWorkspaceActions();
  return (
    <ContextMenuContent>
      <ContextMenuItem onClick={() => actions.duplicateTab(tab.id)}>
        {t('explorer.tab.duplicate')}
      </ContextMenuItem>
      <ContextMenuItem disabled={!canSplit} onClick={() => actions.splitTab(tab.id)}>
        {t('explorer.tab.openInSplit')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => actions.closeTab(tab.id)}>
        {t('explorer.tab.close')}
      </ContextMenuItem>
      <ContextMenuItem disabled={onlyTab} onClick={() => actions.closeOtherTabs(tab.id)}>
        {t('explorer.tab.closeOthers')}
      </ContextMenuItem>
      {closablePaneId !== null && (
        <ContextMenuItem onClick={() => actions.closePane(closablePaneId)}>
          {t('explorer.tab.closePane')}
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  );
}

function TabContent({ tab, active, node, showNode }: ExplorerTabItemProps) {
  const { t } = useTranslation();
  const { closeTab } = useWorkspaceActions();
  const root = useTabRoot(node ? tab.nodeId : null, tab.rootId);
  const label = tabLabel(explorerTabPath(tab), root);

  const close = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    closeTab(tab.id);
  };

  return (
    <>
      <span
        aria-hidden="true"
        data-online={node?.online ?? false}
        className={cn(
          'size-1.5 shrink-0 rounded-full transition-colors duration-(--vibeterm-motion-standard) motion-reduce:transition-none',
          node?.online ? 'bg-emerald-500' : 'bg-gray-400'
        )}
      />
      {showNode && node && (
        <span className="max-w-16 shrink-0 truncate rounded border border-border/60 px-1 py-px text-[10px] text-muted-foreground leading-none">
          {node.name}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button
        type="button"
        draggable={false}
        aria-label={t('explorer.tab.close')}
        data-testid={`explorer-tab-close-${tab.id}`}
        className={cn(CLOSE_CLASS, active && 'opacity-100')}
        onClick={close}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <X className="size-3" />
      </button>
    </>
  );
}

function useTabHandlers({ tab, onArrow }: ExplorerTabItemProps) {
  const { activateTab, closeTab } = useWorkspaceActions();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      onArrow(tab.id, event.key === 'ArrowLeft' ? -1 : 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateTab(tab.id);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      closeTab(tab.id);
    }
  };

  // 中键：按下时拦掉浏览器的自动滚动，抬起时关闭
  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button === 1) event.preventDefault();
  };
  const onAuxClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 1) return;
    event.preventDefault();
    closeTab(tab.id);
  };

  const onDragStart = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData(EXPLORER_TAB_MIME, tab.id);
    event.dataTransfer.effectAllowed = 'move';
    setDraggedTabId(tab.id);
  };

  return {
    onClick: () => activateTab(tab.id),
    onKeyDown,
    onMouseDown,
    onAuxClick,
    onDragStart,
    onDragEnd: () => setDraggedTabId(null),
  };
}

export function ExplorerTabItem(props: ExplorerTabItemProps) {
  const { tab, active, node, isNew, draggable } = props;
  // 入场动画靠 max-width 展开，期间不能带最小宽度；播完再换回常规尺寸约束
  const [entering, setEntering] = useState(isNew);
  const handlers = useTabHandlers(props);
  const fileDrop = useTabFileDrop(tab, active);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            draggable={draggable}
            title={tabTitle(node?.name, explorerTabPath(tab))}
            data-tab-id={tab.id}
            data-testid={`explorer-tab-${tab.id}`}
            data-active={active || undefined}
            className={cn(
              TAB_CLASS,
              entering ? 'vibeterm-explorer-tab-in overflow-hidden' : 'min-w-28',
              active
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-background/60 hover:text-foreground data-[popup-open]:bg-background/60',
              fileDrop.over && 'vibeterm-explorer-drop bg-primary/10 text-foreground'
            )}
            {...handlers}
            onAnimationEnd={() => setEntering(false)}
            onDragOver={fileDrop.onDragOver}
            onDragLeave={fileDrop.onDragLeave}
            onDrop={fileDrop.onDrop}
          >
            <TabContent {...props} />
          </div>
        }
      />
      <TabMenuItems {...props} />
    </ContextMenu>
  );
}
