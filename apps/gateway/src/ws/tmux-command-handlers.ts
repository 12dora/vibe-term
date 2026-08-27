import type { ThemeMode } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import type { DeviceTreeOrderRecord } from '../db';
import type { SettingsNamespace } from '../settings/broadcaster';
import { isTmuxPaneId, isTmuxWindowId } from '../tmux-client/snapshot-format';
import { switchBarrier } from './borsh/switch-barrier';
import { parseWindowLayoutSize } from './frame-utils';
import type { GatewaySession } from './gateway-session';
import type { TerminalOutputBatcher } from './terminal-output-batcher';
import type { DeviceConnectionEntry, WebSocketServerDeps } from './types';

export interface TmuxCommandHost {
  readonly connections: Map<string, DeviceConnectionEntry>;
  readonly windowCustomNames: Map<string, Map<string, string>>;
  readonly paneCustomNames: Map<string, Map<string, string>>;
  readonly currentTheme: ThemeMode | null;
  readonly lastBroadcastTheme: Map<string, 'dark' | 'light'>;
  readonly terminalOutputBatcher: TerminalOutputBatcher;
  readonly deps: WebSocketServerDeps;
  sendError(
    session: GatewaySession,
    refSeq: number | null,
    code: number,
    message: string,
    retryable: boolean
  ): void;
  sendChunked(session: GatewaySession, kind: number, payload: Uint8Array): boolean;
  refreshSnapshotPolling(deviceId: string): void;
  broadcastSettingsUpdate(namespace: SettingsNamespace): void;
  broadcastThemeChange(theme: 'dark' | 'light'): void;
  sendSnapshotToClients(
    entry: DeviceConnectionEntry,
    payload: NonNullable<DeviceConnectionEntry['lastSnapshot']>
  ): void;
  getCachedDeviceTreeOrder(deviceId: string): DeviceTreeOrderRecord;
  storeDeviceTreeOrder(order: DeviceTreeOrderRecord): DeviceTreeOrderRecord;
}

export function canSelectWindow(
  entry: DeviceConnectionEntry,
  deviceId: string,
  windowId: string | undefined
): windowId is string {
  if (!isTmuxWindowId(windowId)) {
    console.warn(`[ws] rejecting invalid tmux window id on ${deviceId}: ${windowId ?? ''}`);
    entry.runtime.requestSnapshot();
    return false;
  }

  const windows = entry.lastSnapshot?.session?.windows;
  if (!windows?.some((window) => window.id === windowId)) {
    console.warn(`[ws] rejecting missing tmux window id on ${deviceId}: ${windowId}`);
    entry.runtime.requestSnapshot();
    return false;
  }

  return true;
}

export function canSelectPane(
  entry: DeviceConnectionEntry,
  deviceId: string,
  windowId: string | undefined,
  paneId: string | undefined
): windowId is string {
  if (!canSelectWindow(entry, deviceId, windowId)) {
    return false;
  }

  if (!isTmuxPaneId(paneId)) {
    console.warn(`[ws] rejecting invalid tmux pane id on ${deviceId}: ${paneId ?? ''}`);
    entry.runtime.requestSnapshot();
    return false;
  }

  const window = entry.lastSnapshot?.session?.windows.find(
    (candidate) => candidate.id === windowId
  );
  if (!window?.panes.some((pane) => pane.id === paneId)) {
    console.warn(`[ws] rejecting missing tmux pane id on ${deviceId}: ${paneId}`);
    entry.runtime.requestSnapshot();
    return false;
  }

  return true;
}

export function handleTmuxSelect(
  host: TmuxCommandHost,
  session: GatewaySession,
  data: wsBorsh.b.infer<typeof wsBorsh.schema.TmuxSelectSchema>
): void {
  const deviceId = data.deviceId;
  const entry = host.connections.get(deviceId);
  if (!entry) return;

  const windowId = data.windowId ?? undefined;
  const paneId = data.paneId ?? undefined;
  if (!windowId || !paneId) return;
  if (!canSelectPane(entry, deviceId, windowId, paneId)) return;

  host.terminalOutputBatcher.flushDevice(deviceId);
  const started = switchBarrier.startTransaction(session, {
    deviceId,
    windowId,
    paneId,
    selectToken: data.selectToken,
    wantHistory: data.wantHistory,
    cols: data.cols ?? null,
    rows: data.rows ?? null,
  });

  if (!started) {
    host.sendError(
      session,
      null,
      wsBorsh.ERROR_SELECT_CONFLICT,
      'Failed to start select transaction',
      false
    );
    return;
  }

  session.borshState.selectedPanes[deviceId] = paneId;
  host.refreshSnapshotPolling(deviceId);
  switchBarrier.sendSwitchAck(session, deviceId);

  const cols = data.cols ?? null;
  const rows = data.rows ?? null;
  if (cols !== null && rows !== null) {
    entry.runtime.selectPaneWithSize(windowId, paneId, cols, rows);
  } else {
    entry.runtime.selectPane(windowId, paneId);
  }
}

export function handleTmuxSelectWindow(
  host: TmuxCommandHost,
  deviceId: string,
  windowId: string
): void {
  const entry = host.connections.get(deviceId);
  if (!entry) return;
  if (!canSelectWindow(entry, deviceId, windowId)) return;
  entry.runtime.selectWindow(windowId);
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

export function handleTermResize(
  host: TmuxCommandHost,
  deviceId: string,
  paneId: string,
  cols: number,
  rows: number
): void {
  const entry = host.connections.get(deviceId);
  if (!entry) return;

  const window = entry.lastSnapshot?.session?.windows?.find((w) =>
    w.panes?.some((p) => p.id === paneId)
  );

  if (window?.panes && window.panes.length > 1) {
    const currentSize = parseWindowLayoutSize(window.layout);
    if (currentSize && currentSize.cols === cols && currentSize.rows === rows) {
      return;
    }
    entry.runtime.resizeWindow(window.id, cols, rows);
    return;
  }

  const pane = window?.panes.find((p) => p.id === paneId);
  if (pane && pane.width === cols && pane.height === rows) {
    return;
  }

  entry.runtime.resizePane(paneId, cols, rows);
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
  const entry = host.connections.get(deviceId);
  if (!entry?.lastSnapshot) return;
  host.sendSnapshotToClients(entry, entry.lastSnapshot);
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
  const entry = host.connections.get(deviceId);
  if (!entry?.lastSnapshot) return;
  host.sendSnapshotToClients(entry, entry.lastSnapshot);
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
  const entry = host.connections.get(deviceId);
  if (!entry?.lastSnapshot) return;
  host.sendSnapshotToClients(entry, entry.lastSnapshot);
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
  const entry = host.connections.get(deviceId);
  if (!entry?.lastSnapshot) return;
  host.sendSnapshotToClients(entry, entry.lastSnapshot);
}

export function handleSubscribePanes(
  host: TmuxCommandHost,
  session: GatewaySession,
  deviceId: string,
  paneIds: string[]
): void {
  const entry = host.connections.get(deviceId);
  if (!entry) return;

  const knownPaneIds = new Set(
    entry.lastSnapshot?.session?.windows.flatMap((window) => window.panes.map((pane) => pane.id)) ??
      []
  );
  const accepted = new Set<string>();
  for (const paneId of paneIds) {
    if (isTmuxPaneId(paneId) && knownPaneIds.has(paneId)) {
      accepted.add(paneId);
    }
  }

  host.terminalOutputBatcher.flushDevice(deviceId);
  if (accepted.size > 0) {
    session.borshState.subscribedPanes[deviceId] = accepted;
  } else {
    delete session.borshState.subscribedPanes[deviceId];
  }
  host.refreshSnapshotPolling(deviceId);
}

export function handleFetchPaneHistory(
  host: TmuxCommandHost,
  session: GatewaySession,
  deviceId: string,
  paneId: string,
  requestToken: Uint8Array
): void {
  const entry = host.connections.get(deviceId);
  if (!entry || !isTmuxPaneId(paneId)) return;

  void entry.runtime
    .fetchPaneHistory(paneId)
    .then((captured) => {
      if (!captured) return;
      const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.TermHistorySchema, {
        deviceId,
        paneId,
        selectToken: requestToken,
        encoding: 1,
        alternateScreen: captured.alternateScreen,
        modes: captured.modes,
        data: new TextEncoder().encode(captured.data),
      });
      host.sendChunked(session, wsBorsh.KIND_TERM_HISTORY, payloadBytes);
    })
    .catch((error) => {
      console.warn(`[ws] fetch pane history failed on ${deviceId}/${paneId}:`, error);
    });
}

export function handleResizePaneById(
  host: TmuxCommandHost,
  deviceId: string,
  paneId: string,
  cols?: number,
  rows?: number
): void {
  const entry = host.connections.get(deviceId);
  if (!entry || !isTmuxPaneId(paneId)) return;
  if (cols === undefined && rows === undefined) return;
  entry.runtime.resizePaneById(paneId, { cols, rows });
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
  session: GatewaySession,
  deviceId: string,
  windowId: string,
  paneId: string
): void {
  const entry = host.connections.get(deviceId);
  if (!entry) return;
  if (!canSelectPane(entry, deviceId, windowId, paneId)) return;

  session.borshState.selectedPanes[deviceId] = paneId;
  host.refreshSnapshotPolling(deviceId);
  entry.runtime.focusPane(windowId, paneId);
}
