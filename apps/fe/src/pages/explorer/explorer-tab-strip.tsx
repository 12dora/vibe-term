// 一个分栏的标签栏：可横向滚动的标签页 + 滑动指示条 + 拖放插入线 + 末尾的「新建标签页」。

import type { ExplorerPane, ExplorerTab, ExplorerWorkspaceState } from '@vibeterm/stores';
import { useExplorerStore } from '@vibeterm/stores/explorer';

import { cn } from '@vibeterm/ui';
import { Button } from '@vibeterm/ui/button';
import { IconTooltip } from '@vibeterm/ui/icon-tooltip';
import { Plus } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useExplorerNodes } from './explorer-nodes';
import { ExplorerTabItem } from './explorer-tab';
import { neighbourTabId, stripTabsView } from './strip-view';
import { hasMultipleNodes } from './tab-label';
import { useCanSplit } from './use-can-split';
import { useTabIndicator } from './use-tab-indicator';
import { useTabStripDrop } from './use-tab-strip-drop';
import { useTabStripScroll } from './use-tab-strip-scroll';
import { useWorkspaceActions } from './workspace-actions';

const showsMultipleNodes = (state: ExplorerWorkspaceState) =>
  hasMultipleNodes(Object.values(state.tabs));

function resolveTabs(tabIds: readonly string[], tabs: Record<string, ExplorerTab>): ExplorerTab[] {
  return tabIds.flatMap((id) => (tabs[id] ? [tabs[id]] : []));
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

interface ArrowNavigationOptions {
  tabIds: readonly string[];
  rowRef: RefObject<HTMLElement | null>;
  onKeyboardActivate?: (tabId: string) => void;
}

/** 方向键：切到相邻标签页并把焦点带过去（到头不循环） */
function useArrowNavigation({ tabIds, rowRef, onKeyboardActivate }: ArrowNavigationOptions) {
  const { activateTab } = useWorkspaceActions();
  return useCallback(
    (tabId: string, delta: -1 | 1) => {
      const nextId = neighbourTabId(tabIds, tabId, delta);
      if (nextId === null) return;
      // 先登记「这次激活来自键盘」：新主体挂载后会抢焦点，分栏据此把焦点还给标签页
      onKeyboardActivate?.(nextId);
      activateTab(nextId);
      const tabs = Array.from(rowRef.current?.children ?? []);
      const next = tabs.find((el) => el instanceof HTMLElement && el.dataset.tabId === nextId);
      if (next instanceof HTMLElement) next.focus();
    },
    [tabIds, rowRef, activateTab, onKeyboardActivate]
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

export interface ExplorerTabStripProps {
  pane: ExplorerPane;
  /** 窄屏：把所有分栏的标签页并进这一条（此时不支持拖动重排） */
  merged?: boolean;
  /** 方向键切换标签页时通知分栏，好让它守住标签页上的焦点 */
  onKeyboardActivate?: (tabId: string) => void;
}

export function ExplorerTabStrip(props: ExplorerTabStripProps) {
  const { pane, merged = false, onKeyboardActivate } = props;
  const allTabs = useExplorerStore((state) => state.tabs);
  const panes = useExplorerStore((state) => state.panes);
  const showNode = useExplorerStore(showsMultipleNodes);
  const nodes = useExplorerNodes();
  const canSplit = useCanSplit();

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const view = useMemo(() => stripTabsView(panes, pane, merged), [panes, pane, merged]);
  const tabs = resolveTabs(view.tabIds, allTabs);
  const layoutKey = view.tabIds.join('|');
  const multiPane = panes.length > 1;

  const isNew = useNewTabCheck(view.tabIds);
  const scroll = useTabStripScroll(scrollRef, pane.activeTabId, layoutKey);
  const indicator = useTabIndicator(rowRef, pane.activeTabId, layoutKey);
  const drop = useTabStripDrop(pane.id, rowRef, !merged);
  const onArrow = useArrowNavigation({ tabIds: view.tabIds, rowRef, onKeyboardActivate });

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
              canSplit={canSplit}
              onlyTab={(view.ownerOf.get(tab.id)?.tabIds.length ?? 1) === 1}
              closablePaneId={multiPane ? (view.ownerOf.get(tab.id)?.id ?? null) : null}
              draggable={!merged}
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
