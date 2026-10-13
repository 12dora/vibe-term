// 一个分栏：标签栏 + 活动标签页的主体。点到或聚焦到栏内任何位置都会让它成为活动分栏。

import { useExplorerStore } from '@vibeterm/stores/explorer';
import { cn } from '@vibeterm/ui';
import { useRef } from 'react';
import { ExplorerEmpty } from './explorer-empty';
import { ExplorerTabBody } from './explorer-tab-body';
import { ExplorerTabStrip } from './explorer-tab-strip';
import { useKeepTabFocus } from './use-keep-tab-focus';
import { useWorkspaceActions } from './workspace-actions';

// 活动分栏的描边画在伪元素上：直接给容器加 inset ring 会被子元素的背景盖住
const ACTIVE_RING_CLASS =
  'after:pointer-events-none after:absolute after:inset-0 after:z-20 after:opacity-0 after:ring-1 after:ring-primary/30 after:ring-inset after:transition-opacity after:duration-(--vibeterm-motion-standard) after:ease-out after:content-[""] motion-reduce:after:transition-none';

export interface ExplorerPaneViewProps {
  paneId: string;
  /** 窄屏：只画这一个分栏，标签栏并入所有分栏的标签页 */
  mergedStrip?: boolean;
}

export function ExplorerPaneView({ paneId, mergedStrip = false }: ExplorerPaneViewProps) {
  const pane = useExplorerStore((state) => state.panes.find((item) => item.id === paneId));
  const activeTab = useExplorerStore((state) => {
    const tabId = state.panes.find((item) => item.id === paneId)?.activeTabId;
    return tabId ? (state.tabs[tabId] ?? null) : null;
  });
  const isActivePane = useExplorerStore((state) => state.activePaneId === paneId);
  const multiPane = useExplorerStore((state) => state.panes.length > 1);
  const { setActivePane } = useWorkspaceActions();
  const paneRef = useRef<HTMLElement | null>(null);
  const tabFocus = useKeepTabFocus(paneRef, activeTab?.id ?? null);

  if (!pane) return null;
  const activate = () => {
    if (!isActivePane) setActivePane(paneId);
  };

  return (
    <section
      ref={paneRef}
      data-testid={`explorer-pane-${paneId}`}
      data-active={isActivePane || undefined}
      className={cn(
        'relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background',
        ACTIVE_RING_CLASS,
        multiPane && !mergedStrip && isActivePane && 'after:opacity-100'
      )}
      onPointerDownCapture={() => {
        tabFocus.onPointerDownCapture();
        activate();
      }}
      onKeyDownCapture={tabFocus.onKeyDownCapture}
      onFocusCapture={activate}
    >
      <ExplorerTabStrip
        pane={pane}
        merged={mergedStrip}
        onKeyboardActivate={tabFocus.onKeyboardActivate}
      />
      <div className="min-h-0 flex-1 overflow-hidden" onFocusCapture={tabFocus.onBodyFocusCapture}>
        {activeTab ? (
          <ExplorerTabBody key={activeTab.id} tab={activeTab} active={isActivePane} />
        ) : (
          <ExplorerEmpty compact />
        )}
      </div>
    </section>
  );
}
