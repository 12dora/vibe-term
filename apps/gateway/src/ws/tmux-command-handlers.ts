import type { ThemeMode } from '@tmex/shared';
import type { DeviceTreeOrderRecord } from '../db';
import type { SettingsNamespace } from '../settings/broadcaster';
import { isTmuxPaneId } from '../tmux-client/snapshot-format';
import type { GatewaySession } from './gateway-session';
import { canSelectPane, canSelectWindow } from './tmux-selection-handlers';
import type { DeviceConnectionEntry, WebSocketServerDeps } from './types';

export { handleTmuxSelect, handleTmuxSelectWindow } from './tmux-selection-handlers';
export type { CanonicalResizeIntent } from './tmux-geometry-handlers';
export {
  dropPaneSizeEpochs,
  dropViewportClaims,
  handleCanonicalResize,
  handleResizePaneById,
  handleTermViewport,
  reconcileDeviceViewportSnapshot,
} from './tmux-geometry-handlers';

export interface TmuxCommandHost {
  readonly connections: Map<string, DeviceConnectionEntry>;
  readonly windowCustomNames: Map<string, Map<string, string>>;
  readonly paneCustomNames: Map<string, Map<string, string>>;
  readonly currentTheme: ThemeMode | null;
  readonly lastBroadcastTheme: Map<string, 'dark' | 'light'>;
  readonly deps: WebSocketServerDeps;
  sendError(
    session: GatewaySession,
    refSeq: number | null,
    code: number,
    message: string,
    retryable: boolean
  ): void;
  sendEnvelope(session: GatewaySession, kind: number, payload: Uint8Array): void;
  refreshSnapshotPolling(deviceId: string): void;
  broadcastSettingsUpdate(namespace: SettingsNamespace): void;
  broadcastThemeChange(theme: 'dark' | 'light'): void;
  getCachedDeviceTreeOrder(deviceId: string): DeviceTreeOrderRecord;
  storeDeviceTreeOrder(order: DeviceTreeOrderRecord): DeviceTreeOrderRecord;
}

export function handleTermInput(
  host: TmuxCommandHost,
  deviceId: string,
  paneId: string,
  data: string
): void {
  const entry = host.connections.get(deviceId);
  if (!entry) return;
  entry.runtime.sendInput(paneId, data);
}

export function handleTermPaste(
  host: TmuxCommandHost,
  deviceId: string,
  paneId: string,
  data: string
): void {
  const entry = host.connections.get(deviceId);
  if (!entry) return;

  const chunkSize = 1024;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, i + chunkSize);
    entry.runtime.sendInput(paneId, chunk);
  }
}

export function handleCreateWindow(
  host: TmuxCommandHost,
  deviceId: string,
  name?: string,
  cwd?: string
): void {
  const entry = host.connections.get(deviceId);
  if (!entry) return;
  entry.runtime.createWindow(name, cwd);
}

export function handleCloseWindow(host: TmuxCommandHost, deviceId: string, windowId: string): void {
  const entry = host.connections.get(deviceId);
  if (!entry) return;
  entry.runtime.closeWindow(windowId);
}

export function handleClosePane(host: TmuxCommandHost, deviceId: string, paneId: string): void {
  const entry = host.connections.get(deviceId);
  if (!entry) return;
  entry.runtime.closePane(paneId);
}

export function renamePane(
  host: TmuxCommandHost,
  deviceId: string,
  paneId: string,
  name: string
): void {
  if (!isTmuxPaneId(paneId)) return;
  const trimmed = name.trim().slice(0, 64);
  const names = host.paneCustomNames.get(deviceId);

  if (!trimmed) {
    names?.delete(paneId);
  } else if (names) {
    names.set(paneId, trimmed);
  } else {
    host.paneCustomNames.set(deviceId, new Map([[paneId, trimmed]]));
  }

  host.connections.get(deviceId)?.runtime.setCustomName?.('pane', paneId, trimmed || null);
  host.broadcastSettingsUpdate('tree-order');
}

export function handleBreakPane(host: TmuxCommandHost, deviceId: string, paneId: string): void {
  const entry = host.connections.get(deviceId);
  if (!entry || !isTmuxPaneId(paneId)) return;
  entry.runtime.breakPane(paneId);
}

export function handleMovePane(
  host: TmuxCommandHost,
  deviceId: string,
  srcPaneId: string,
  dstPaneId: string,
  position: number
): void {
  const entry = host.connections.get(deviceId);
  if (!entry || !isTmuxPaneId(srcPaneId) || !isTmuxPaneId(dstPaneId)) return;
  if (srcPaneId === dstPaneId) return;
  const positionMap: Record<number, 'left' | 'right' | 'top' | 'bottom'> = {
    1: 'left',
    2: 'right',
    3: 'top',
    4: 'bottom',
  };
  const resolved = positionMap[position];
  if (!resolved) return;
  entry.runtime.movePane(srcPaneId, dstPaneId, resolved);
}

export function renameWindow(
  host: TmuxCommandHost,
  deviceId: string,
  windowId: string,
  name: string
): void {
  const trimmed = name.trim().slice(0, 64);
  const names = host.windowCustomNames.get(deviceId);

  if (!trimmed) {
    names?.delete(windowId);
  } else if (names) {
    names.set(windowId, trimmed);
  } else {
    host.windowCustomNames.set(deviceId, new Map([[windowId, trimmed]]));
  }

  host.connections.get(deviceId)?.runtime.setCustomName?.('window', windowId, trimmed || null);
  host.broadcastSettingsUpdate('tree-order');
}

export function getCustomNames(
  host: TmuxCommandHost,
  deviceId: string
): {
  windows: Record<string, string>;
  panes: Record<string, string>;
} {
  return {
    windows: Object.fromEntries(host.windowCustomNames.get(deviceId) ?? []),
    panes: Object.fromEntries(host.paneCustomNames.get(deviceId) ?? []),
  };
}

export function handleSetWindowStyle(host: TmuxCommandHost, deviceId: string, style: string): void {
  const entry = host.connections.get(deviceId);
  if (!entry) return;
  void (async () => {
    try {
      await entry.runtime.setWindowStyle(style);
    } catch (err) {
      console.error('[ws] setWindowStyle failed:', err);
    }
    if (host.currentTheme !== null) {
      const theme = host.currentTheme;
      if (host.lastBroadcastTheme.get(deviceId) !== theme) {
        host.lastBroadcastTheme.set(deviceId, theme);
        host.broadcastThemeChange(theme);
      }
    }
  })();
}

export function reorderWindows(host: TmuxCommandHost, deviceId: string, windowIds: string[]): void {
  const currentOrder = host.getCachedDeviceTreeOrder(deviceId);
  host.deps.saveWindowOrder(deviceId, windowIds);
  host.storeDeviceTreeOrder({
    deviceId,
    windows: windowIds,
    panes: currentOrder.panes,
  });
  host.broadcastSettingsUpdate('tree-order');
}

export function reorderPanes(
  host: TmuxCommandHost,
  deviceId: string,
  windowId: string,
  paneIds: string[]
): void {
  const currentOrder = host.getCachedDeviceTreeOrder(deviceId);
  host.deps.savePaneOrder(deviceId, windowId, paneIds);
  host.storeDeviceTreeOrder({
    deviceId,
    windows: currentOrder.windows,
    panes: {
      ...currentOrder.panes,
      [windowId]: paneIds,
    },
  });
  host.broadcastSettingsUpdate('tree-order');
}

export function handleApplyStackedLayout(
  host: TmuxCommandHost,
  deviceId: string,
  windowId: string,
  cols: number,
  rows: number
): void {
  const entry = host.connections.get(deviceId);
  if (!entry) return;
  if (!canSelectWindow(entry, deviceId, windowId)) return;
  if (cols < 2 || rows < 2) return;

  const window = entry.lastSnapshot?.session?.windows.find(
    (candidate) => candidate.id === windowId
  );
  const paneCount = window?.panes.length ?? 0;
  if (!window || paneCount === 0) return;

  const alreadyStacked = window.panes.every((pane) => pane.width === cols && pane.height === rows);
  if (alreadyStacked) return;

  const TMUX_MAX_WINDOW_COLS = 10_000;
  const totalCols = paneCount * cols + (paneCount - 1);
  const clampedCols = Math.min(totalCols, TMUX_MAX_WINDOW_COLS);
  if (clampedCols !== totalCols) {
    console.warn(
      `[ws] stacked layout width clamped on ${deviceId}/${windowId}: ${totalCols} -> ${clampedCols}`
    );
  }

  if (paneCount === 1) {
    entry.runtime.resizeWindow(windowId, clampedCols, rows);
    return;
  }

  entry.runtime.applyStackedLayout(windowId, clampedCols, rows);
}

export function handleSplitPane(
  host: TmuxCommandHost,
  deviceId: string,
  paneId: string,
  direction: number,
  cwd?: string
): void {
  const entry = host.connections.get(deviceId);
  if (!entry || !isTmuxPaneId(paneId)) return;
  const dir = direction === 2 ? 'v' : 'h';
  entry.runtime.splitPane(paneId, dir, cwd);
}

export function handleFocusPane(
  host: TmuxCommandHost,
  deviceId: string,
  windowId: string,
  paneId: string
): void {
  const entry = host.connections.get(deviceId);
  if (!entry) return;
  if (!canSelectPane(entry, deviceId, windowId, paneId)) return;

  host.refreshSnapshotPolling(deviceId);
  entry.runtime.focusPane(windowId, paneId);
}
