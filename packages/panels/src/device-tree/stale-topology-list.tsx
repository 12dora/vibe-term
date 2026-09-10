// 冷启动占位树：设备还没有实时快照时，用上一次会话缓存下来的窗口 / pane 结构先把
// 「标签页」列出来，点某一行才真正去 attach（跳路由 + 触发连接）。
//
// 行是灰显的，且只接受点击——拖拽重排、重命名、关闭这些操作都要实时数据支撑，
// 挂在占位行上只会发出打不中的指令。

import type { CachedTopology, CachedTopologyPane, CachedTopologyWindow } from '@vibeterm/stores';
import { buildWindowTitleParts } from '@vibeterm/stores';
import { useRuntime } from '@vibeterm/stores/react';
import { cn } from '@vibeterm/ui';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceConnectionAdapter } from '../device-connection';
import { pickActivePane } from './device-tree-navigation';
import { RowLabel, processSubtitle } from './row-label';

const ROW_BASE =
  'flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-muted-foreground transition-colors duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none hover:bg-accent/30 [@media(any-pointer:coarse)]:py-2.5';

/** 与实时行的拖拽手柄同宽的占位，保证两种状态下缩进一致 */
function HandleSpacer() {
  return <span aria-hidden className="w-3.5 shrink-0 [@media(any-pointer:coarse)]:w-4" />;
}

export interface StaleTopologyListProps {
  deviceId: string;
  topology: CachedTopology;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  /** 宿主连接管理；未传时直接走 tmux store 的 connectDevice */
  connection?: DeviceConnectionAdapter;
}

export interface OpenStalePaneDeps {
  deviceId: string;
  windowId: string;
  paneId: string;
  connection?: Pick<DeviceConnectionAdapter, 'isConnected' | 'connect'>;
  /** 宿主没接连接管理时的兜底：直接用 tmux store 订阅设备 */
  tmux: { connectedDevices: ReadonlySet<string>; connectDevice: (deviceId: string) => void };
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
}

/**
 * 点占位行即视为「要用这台设备」：没连上就先把连接拉起来（宿主接了连接管理时走它，
 * 顺带把连接意图记下，用户此前显式断开的设备才不会一点就死），再跳到目标 pane。
 */
export function openStalePane(deps: OpenStalePaneDeps): void {
  const { deviceId, windowId, paneId, connection, tmux, onPaneClick } = deps;
  if (connection) {
    if (!connection.isConnected(deviceId)) connection.connect(deviceId);
  } else if (!tmux.connectedDevices.has(deviceId)) {
    tmux.connectDevice(deviceId);
  }
  onPaneClick(deviceId, windowId, paneId);
}

function useOpenStalePane({
  deviceId,
  onPaneClick,
  connection,
}: StaleTopologyListProps): (windowId: string, paneId: string) => void {
  const runtime = useRuntime();

  return useCallback(
    (windowId: string, paneId: string) => {
      openStalePane({
        deviceId,
        windowId,
        paneId,
        connection,
        tmux: runtime.stores.tmux.getState(),
        onPaneClick,
      });
    },
    [connection, deviceId, onPaneClick, runtime]
  );
}

export function StaleTopologyList(props: StaleTopologyListProps) {
  const { deviceId, topology } = props;
  const { t } = useTranslation();
  const openPane = useOpenStalePane(props);

  return (
    <div
      data-testid={`stale-topology-${deviceId}`}
      title={t('sidebar.topologyStale')}
      className="space-y-1.5 opacity-70 [@media(any-pointer:coarse)]:space-y-2"
    >
      {topology.windows.map((tmuxWindow) => (
        <StaleWindowRow key={tmuxWindow.id} tmuxWindow={tmuxWindow} onOpenPane={openPane} />
      ))}
    </div>
  );
}

interface StaleWindowRowProps {
  tmuxWindow: CachedTopologyWindow;
  onOpenPane: (windowId: string, paneId: string) => void;
}

function StaleWindowRow({ tmuxWindow, onOpenPane }: StaleWindowRowProps) {
  const { t } = useTranslation();
  const { panes, id: windowId } = tmuxWindow;
  const hasMultiplePanes = panes.length > 1;
  const titleParts = buildWindowTitleParts(tmuxWindow);
  const headerPane = pickActivePane(panes);

  const handleHeaderClick = useCallback(() => {
    if (headerPane) onOpenPane(windowId, headerPane.id);
  }, [headerPane, onOpenPane, windowId]);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <HandleSpacer />
        <button
          type="button"
          onClick={handleHeaderClick}
          disabled={!headerPane}
          data-testid={`stale-window-item-${windowId}`}
          className={cn(ROW_BASE, !headerPane && 'cursor-default')}
        >
          {hasMultiplePanes ? (
            <span className="flex-1 min-w-0 font-mono text-[10.5px] leading-tight">
              {t('window.paneCount', { count: panes.length })}
            </span>
          ) : (
            <RowLabel title={titleParts.title} subtitle={processSubtitle(titleParts.processName)} />
          )}
        </button>
      </div>
      {hasMultiplePanes && (
        <div className="ml-4.5 pl-2 border-l border-border/50 space-y-1">
          {panes.map((pane) => (
            <StalePaneRow key={pane.id} pane={pane} windowId={windowId} onOpenPane={onOpenPane} />
          ))}
        </div>
      )}
    </div>
  );
}

interface StalePaneRowProps {
  pane: CachedTopologyPane;
  windowId: string;
  onOpenPane: (windowId: string, paneId: string) => void;
}

function StalePaneRow({ pane, windowId, onOpenPane }: StalePaneRowProps) {
  const { t } = useTranslation();
  const handleClick = useCallback(
    () => onOpenPane(windowId, pane.id),
    [onOpenPane, pane.id, windowId]
  );

  return (
    <div className="flex items-center gap-1">
      <HandleSpacer />
      <button
        type="button"
        onClick={handleClick}
        data-testid={`stale-pane-item-${pane.id}`}
        className={cn(ROW_BASE, 'py-1 [@media(any-pointer:coarse)]:py-2')}
      >
        <RowLabel
          title={pane.customName || pane.title || t('window.pane')}
          subtitle={processSubtitle(pane.currentCommand)}
        />
      </button>
    </div>
  );
}
