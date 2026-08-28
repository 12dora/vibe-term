import { useRuntime } from '@tmex/stores/react';
import { useCallback } from 'react';
import { SortableVerticalList } from './device-tree-dnd';
import type { WindowRowProps } from './device-tree-row-props';
import { PaneRow } from './pane-row';

export interface WindowRowFooterProps extends WindowRowProps {
  paneIds: string[];
  isWindowSelected: boolean;
  isMobile: boolean;
}

/** 窗口行下挂的子树：多 pane 走 pane 列表，单 pane 直接挂 Agent 会话分支 */
export function WindowRowFooter(props: WindowRowFooterProps) {
  const { deviceId, tmuxWindow, agent, nav } = props;
  const { stores } = useRuntime();
  const { panes, id: windowId } = tmuxWindow;

  const handleReorder = useCallback(
    (nextIds: string[]) => stores.tmux.getState().reorderPanes(deviceId, windowId, nextIds),
    [stores, deviceId, windowId]
  );

  if (panes.length > 1) return <WindowPaneList {...props} onReorder={handleReorder} />;

  const singlePane = panes[0];
  if (!singlePane || !agent) return null;
  return (
    <div className="ml-[36px] pl-2 border-l border-border/50">
      <agent.PaneSessions nav={nav} deviceId={deviceId} paneId={singlePane.id} />
    </div>
  );
}

interface WindowPaneListProps extends WindowRowFooterProps {
  onReorder: (nextIds: string[]) => void;
}

function WindowPaneList({
  deviceId,
  tmuxWindow,
  paneIds,
  isWindowSelected,
  selectedPaneId,
  isMobile,
  onReorder,
  onPaneClick,
  onClosePane,
  onRenamePane,
  onWatchPane,
  agent,
  nav,
}: WindowPaneListProps) {
  return (
    <div className="ml-4 pl-2 border-l border-border/50 space-y-1 [@media(any-pointer:coarse)]:space-y-1.5">
      <SortableVerticalList ids={paneIds} onReorder={onReorder}>
        {tmuxWindow.panes.map((pane) => (
          <PaneRow
            key={pane.id}
            deviceId={deviceId}
            windowId={tmuxWindow.id}
            pane={pane}
            isActive={isWindowSelected && pane.id === selectedPaneId}
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
  );
}
