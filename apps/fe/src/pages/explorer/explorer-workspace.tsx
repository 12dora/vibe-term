// 文件管理器工作区：分栏横向排开，中间是可拖动的分隔线；窄屏只显示活动分栏。
// 分栏占比拖动时只改本地预览，松手才写进 store（store 每次写入都会落盘）。

import { useNarrowLayout } from '@/components/use-narrow-layout';
import type { ExplorerPane } from '@vibeterm/stores';
import { useExplorerStore } from '@vibeterm/stores/react';
import { cn } from '@vibeterm/ui';
import { type DragEvent, Fragment, useEffect, useRef, useState } from 'react';
import { ExplorerEmpty } from './explorer-empty';
import { useExplorerNodes } from './explorer-nodes';
import { ExplorerPaneView } from './explorer-pane';
import { ExplorerSplitter } from './explorer-splitter';
import { effectivePaneSizes } from './pane-resize';
import { hasOsFileDrag } from './tab-dnd';
import { useWorkspaceActions, useWorkspaceStore } from './workspace-actions';

const SPLITTER_WIDTH_PX = 4;

/** 成员表到齐后，清掉指向已不存在节点的标签页 */
function usePruneStaleTabs(): void {
  const nodes = useExplorerNodes();
  const store = useWorkspaceStore();
  useEffect(() => {
    if (!nodes.ready) return;
    const state = store.getState();
    const known = (nodeId: string) => nodes.find(nodeId) !== undefined;
    // 没有失效标签页就不动 store，免得白白落盘一次
    if (Object.values(state.tabs).every((tab) => known(tab.nodeId))) return;
    state.pruneTabs((tab) => known(tab.nodeId));
  }, [nodes, store]);
}

/** 工作区挂载之后才出现的分栏算「新分出来的」，带一次入场动画 */
function useNewPaneCheck(panes: readonly ExplorerPane[]): (paneId: string) => boolean {
  const initial = useRef<Set<string> | null>(null);
  if (initial.current === null) initial.current = new Set(panes.map((pane) => pane.id));
  const known = initial.current;
  return (paneId) => !known.has(paneId);
}

// 系统文件落在文件列表之外时浏览器会直接打开它（整页跳走）；列表自己接住的拖放已经 preventDefault 过
function blockStrayFileDrag(event: DragEvent<HTMLElement>): void {
  if (event.defaultPrevented || !hasOsFileDrag(event.dataTransfer)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'none';
}

function PaneRow({ panes }: { panes: readonly ExplorerPane[] }) {
  const storedSizes = useExplorerStore((state) => state.paneSizes);
  const { setPaneSizes } = useWorkspaceActions();
  const [preview, setPreview] = useState<number[] | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const isNewPane = useNewPaneCheck(panes);

  const sizes = effectivePaneSizes(preview, storedSizes, panes.length);
  const getTrackWidth = () =>
    (trackRef.current?.clientWidth ?? 0) - (panes.length - 1) * SPLITTER_WIDTH_PX;

  return (
    <div ref={trackRef} className="flex min-h-0 flex-1">
      {panes.map((pane, index) => (
        <Fragment key={pane.id}>
          {index > 0 && (
            <ExplorerSplitter
              index={index - 1}
              sizes={sizes}
              getTrackWidth={getTrackWidth}
              onPreview={setPreview}
              onCommit={setPaneSizes}
            />
          )}
          <div
            style={{ flexGrow: sizes[index], flexBasis: 0 }}
            className={cn(
              'flex min-h-0 min-w-0',
              isNewPane(pane.id) && 'vibeterm-explorer-pane-in'
            )}
          >
            <ExplorerPaneView paneId={pane.id} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

export function ExplorerWorkspace() {
  const panes = useExplorerStore((state) => state.panes);
  const activePaneId = useExplorerStore((state) => state.activePaneId);
  const hasTabs = useExplorerStore((state) => Object.keys(state.tabs).length > 0);
  const narrow = useNarrowLayout();
  usePruneStaleTabs();

  const activePane = panes.find((pane) => pane.id === activePaneId) ?? panes[0];

  return (
    <div
      data-testid="explorer-workspace"
      className="flex h-full min-h-0 flex-col overflow-hidden"
      onDragOver={blockStrayFileDrag}
      onDrop={blockStrayFileDrag}
    >
      {!hasTabs || !activePane ? (
        <ExplorerEmpty />
      ) : narrow ? (
        <div className="flex min-h-0 flex-1">
          <ExplorerPaneView paneId={activePane.id} />
        </div>
      ) : (
        <PaneRow panes={panes} />
      )}
    </div>
  );
}
