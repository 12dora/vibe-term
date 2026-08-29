import type { TmuxWindow } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { Plus } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SortableVerticalList } from './device-tree-dnd';
import type { DeviceRowProps } from './device-tree-row-props';
import { WindowRow } from './window-row';

export interface DeviceWindowListProps extends DeviceRowProps {
  windows: TmuxWindow[] | null;
}

const stopPropagation = (event: { stopPropagation: () => void }) => event.stopPropagation();

/**
 * 展开态的设备子树：加载中 / 空窗口 / 窗口列表 + 新建窗口按钮。
 * 根节点的 `tmex-reveal` 只在展开挂载时播一次；tmux 快照推送只是重渲染，不会重放。
 */
export function DeviceWindowList(props: DeviceWindowListProps) {
  const { device, windows, onCreateWindow } = props;
  const { t } = useTranslation();
  const deviceId = device.id;

  const handleCreateWindow = useCallback(
    () => onCreateWindow(deviceId),
    [onCreateWindow, deviceId]
  );

  return (
    <div
      data-testid={`device-tree-${deviceId}`}
      className="tmex-reveal space-y-1.5 py-1.5 pr-1.5 pl-10 [@media(any-pointer:coarse)]:space-y-2"
    >
      {!windows && <DeviceTreeHint text={t('common.loading')} />}
      {windows?.length === 0 && <DeviceTreeHint text={t('window.noWindows')} />}
      {windows && windows.length > 0 && <DeviceWindowRows {...props} windows={windows} />}

      <button
        type="button"
        data-testid={`window-create-${deviceId}`}
        onPointerDown={stopPropagation}
        onMouseDown={stopPropagation}
        onClick={handleCreateWindow}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none text-muted-foreground hover:text-foreground hover:bg-accent/30 border border-dashed border-border/50 hover:border-border"
      >
        <Plus className="h-3.5 w-3.5 shrink-0" />
        <span className="text-xs">{t('window.new')}</span>
      </button>
    </div>
  );
}

function DeviceTreeHint({ text }: { text: string }) {
  return <div className="text-xs text-muted-foreground px-2 py-1.5 text-center">{text}</div>;
}

function DeviceWindowRows({
  device,
  windows,
  isSelected,
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
}: DeviceWindowListProps & { windows: TmuxWindow[] }) {
  const { stores } = useRuntime();
  const deviceId = device.id;

  const windowIds = useMemo(() => windows.map((w) => w.id), [windows]);
  const handleReorder = useCallback(
    (nextIds: string[]) => stores.tmux.getState().reorderWindows(deviceId, nextIds),
    [stores, deviceId]
  );

  return (
    <SortableVerticalList ids={windowIds} onReorder={handleReorder}>
      {windows.map((tmuxWindow) => (
        <WindowRow
          key={tmuxWindow.id}
          deviceId={deviceId}
          tmuxWindow={tmuxWindow}
          isDeviceSelected={isSelected}
          selectedWindowId={selectedWindowId}
          selectedPaneId={selectedPaneId}
          onPaneClick={onPaneClick}
          onWindowClick={onWindowClick}
          onCloseWindow={onCloseWindow}
          onClosePane={onClosePane}
          onRenameWindow={onRenameWindow}
          onRenamePane={onRenamePane}
          onWatchPane={onWatchPane}
          agent={agent}
          nav={nav}
        />
      ))}
    </SortableVerticalList>
  );
}
