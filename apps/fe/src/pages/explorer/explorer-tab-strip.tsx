// 一个分栏的标签栏：可横向滚动的标签页 + 滑动指示条 + 拖放插入线 + 末尾的「新建标签页」。

import {
  EXPLORER_MAX_PANES,
  type ExplorerPane,
  type ExplorerTab,
  type ExplorerWorkspaceState,
} from '@vibeterm/stores';
import { useExplorerStore } from '@vibeterm/stores/react';
import { cn } from '@vibeterm/ui';
import { Button } from '@vibeterm/ui/button';
import { IconTooltip } from '@vibeterm/ui/icon-tooltip';
import { Plus } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useExplorerNodes } from './explorer-nodes';
import { ExplorerTabItem } from './explorer-tab';
import { hasMultipleNodes } from './tab-label';
import { useTabIndicator } from './use-tab-indicator';
import { useTabStripDrop } from './use-tab-strip-drop';
import { useTabStripScroll } from './use-tab-strip-scroll';
import { useWorkspaceActions } from './workspace-actions';

const showsMultipleNodes = (state: ExplorerWorkspaceState) =>
  hasMultipleNodes(Object.values(state.tabs));

function paneTabs(pane: ExplorerPane, tabs: Record<string, ExplorerTab>): ExplorerTab[] {
  return pane.tabIds.flatMap((id) => (tabs[id] ? [tabs[id]] : []));
}

/** 本栏挂载之后才出现的标签页算「新开的」（挂载时已有的不播入场动画） */
function useNewTabCheck(tabIds: readonly string[]): (tabId: string) => boolean {
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(tabIds);
  const known = seen.current;
  useEffect(() => {
    for (const id of tabIds) known.add(id);
  }, [tabIds, known]);
  return (tabId) => !known.has(tabId);
}

/** 方向键：切到相邻标签页并把焦点带过去（到头不循环） */
function useArrowNavigation(pane: ExplorerPane, rowRef: RefObject<HTMLElement | null>) {
  const { activateTab } = useWorkspaceActions();
  return useCallback(
    (tabId: string, delta: -1 | 1) => {
      const nextId = pane.tabIds[pane.tabIds.indexOf(tabId) + delta];
      if (!nextId) return;
      activateTab(nextId);
      const tabs = Array.from(rowRef.current?.children ?? []);
      const next = tabs.find((el) => el instanceof HTMLElement && el.dataset.tabId === nextId);
      if (next instanceof HTMLElement) next.focus();
    },
    [pane.tabIds, rowRef, activateTab]
  );
}

function NewTabButton({ paneId, activeTabId }: { paneId: string; activeTabId: string | null }) {
  const { t } = useTranslation();
  const { duplicateTab } = useWorkspaceActions();
  const label = t('explorer.tab.new');
  return (
    <IconTooltip label={label} className="mx-1 self-center">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        data-testid={`explorer-tab-new-${paneId}`}
        disabled={activeTabId === null}
        onClick={() => activeTabId !== null && duplicateTab(activeTabId)}
      >
        <Plus className="size-3.5" />
      </Button>
    </IconTooltip>
  );
}

const BAR_CLASS = 'pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-primary';

export function ExplorerTabStrip({ pane }: { pane: ExplorerPane }) {
  const allTabs = useExplorerStore((state) => state.tabs);
  const paneCount = useExplorerStore((state) => state.panes.length);
  const showNode = useExplorerStore(showsMultipleNodes);
  const nodes = useExplorerNodes();

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const tabs = paneTabs(pane, allTabs);
  const layoutKey = pane.tabIds.join('|');

  const isNew = useNewTabCheck(pane.tabIds);
  const scroll = useTabStripScroll(scrollRef, pane.activeTabId, layoutKey);
  const indicator = useTabIndicator(rowRef, pane.activeTabId, layoutKey);
  const drop = useTabStripDrop(pane.id, rowRef);
  const onArrow = useArrowNavigation(pane, rowRef);

  return (
    <div
      data-testid={`explorer-tabstrip-${pane.id}`}
      className="flex h-9 shrink-0 items-stretch border-border/60 border-b bg-muted/40"
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
    >
      <div
        ref={scrollRef}
        className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={scroll.maskStyle}
        onScroll={scroll.onScroll}
        onWheel={scroll.onWheel}
      >
        <div ref={rowRef} role="tablist" className="relative flex h-full w-max min-w-full">
          {tabs.map((tab) => (
            <ExplorerTabItem
              key={tab.id}
              tab={tab}
              active={tab.id === pane.activeTabId}
              node={nodes.find(tab.nodeId)}
              showNode={showNode}
              isNew={isNew(tab.id)}
              canSplit={paneCount < EXPLORER_MAX_PANES}
              onlyTab={pane.tabIds.length === 1}
              closablePaneId={paneCount > 1 ? pane.id : null}
              onArrow={onArrow}
            />
          ))}
          {indicator.style && (
            <span
              aria-hidden="true"
              style={indicator.style}
              className={cn(
                BAR_CLASS,
                indicator.animated &&
                  'transition-[transform,width] duration-(--vibeterm-motion-layout) ease-out motion-reduce:transition-none'
              )}
            />
          )}
          {drop.lineX !== null && (
            <span
              aria-hidden="true"
              style={{ transform: `translateX(${drop.lineX}px)` }}
              className="vibeterm-fade pointer-events-none absolute inset-y-1 left-0 z-10 -ml-px w-0.5 rounded-full bg-primary"
            />
          )}
        </div>
      </div>
      <NewTabButton paneId={pane.id} activeTabId={pane.activeTabId} />
    </div>
  );
}
