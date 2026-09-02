import type { ThemeMode } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { truncateUtf8Tail } from '../bytes';
import type { DeviceTreeOrderRecord } from '../db';
import type { SettingsNamespace } from '../settings/broadcaster';
import { MAX_PANE_HISTORY_CAPTURE_BYTES } from '../tmux-client/control-mode-capture';
import { isTmuxPaneId, isTmuxWindowId } from '../tmux-client/snapshot-format';
import { switchBarrier } from './borsh/switch-barrier';
import { parseWindowLayoutSize } from './frame-utils';
import type { GatewaySession } from './gateway-session';
import type { TerminalOutputBatcher } from './terminal-output-batcher';
import type { DeviceConnectionEntry, WebSocketServerDeps } from './types';
import {
  type ViewportWinner,
  applyWinnerGeometry,
  collectWindowClaims,
  notifyClaimants,
  rebindAllViewportClaims,
  reconcileViewportClaims,
  resolveWinner,
  takeViewportClaimKeys,
  viewportClaimKey,
} from './viewport-policy';

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
  sendEnvelope(session: GatewaySession, kind: number, payload: Uint8Array): void;
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
  syncLegacyPaneObservers(session: GatewaySession, deviceId: string): void;
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
  host.syncLegacyPaneObservers(session, deviceId);
  host.refreshSnapshotPolling(deviceId);
  switchBarrier.sendSwitchAck(session, deviceId);
  dispatchTmuxSelection(host, session, entry, deviceId, windowId, paneId, data);
}

function dispatchTmuxSelection(
  host: TmuxCommandHost,
  session: GatewaySession,
  entry: DeviceConnectionEntry,
  deviceId: string,
  windowId: string,
  paneId: string,
  data: { wantHistory: boolean; cols: number | null; rows: number | null }
): void {
  const requested =
    data.cols != null && data.rows != null ? { cols: data.cols, rows: data.rows } : null;
  let selectSize = requested;
  if (requested) {
    const live = liveWindowGeometry(entry, windowId) ?? entry.lastAppliedViewport?.get(windowId);
    const winner = recordViewportClaim(
      host,
      session,
      {
        deviceId,
        paneId,
        cols: requested.cols,
        rows: requested.rows,
        visible: true,
      },
      { applyUnknown: false, skipResize: data.wantHistory }
    );
    selectSize = resolveSizedSelectSize(session.id, winner, requested, data.wantHistory, live);
  }
  applyTmuxSelection(entry.runtime, windowId, paneId, {
    wantHistory: data.wantHistory,
    cols: selectSize?.cols ?? null,
    rows: selectSize?.rows ?? null,
  });
}

function resolveSizedSelectSize(
  sessionId: string,
  winner: ViewportWinner | null,
  requested: { cols: number; rows: number },
  wantHistory: boolean,
  live: { cols: number; rows: number } | undefined
): { cols: number; rows: number } | null {
  if (!wantHistory) return null;
  if (winner?.sessionId === sessionId) return requested;
  if (!winner || (live?.cols === winner.claim.cols && live?.rows === winner.claim.rows)) {
    return null;
  }
  return { cols: winner.claim.cols, rows: winner.claim.rows };
}

function applyTmuxSelection(
  runtime: DeviceConnectionEntry['runtime'],
  windowId: string,
  paneId: string,
  opts: { wantHistory: boolean; cols: number | null; rows: number | null }
): void {
  const sized = opts.cols !== null && opts.rows !== null;
  if (!opts.wantHistory) {
    runtime.focusPane(windowId, paneId);
    if (sized) runtime.resizePane(paneId, opts.cols as number, opts.rows as number);
    return;
  }
  if (sized) runtime.selectPaneWithSize(windowId, paneId, opts.cols as number, opts.rows as number);
  else runtime.selectPane(windowId, paneId);
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

export function findWindowForPane(entry: DeviceConnectionEntry, paneId: string) {
  return entry.lastSnapshot?.session?.windows?.find((w) => w.panes?.some((p) => p.id === paneId));
}

function resolveResizeWindow(entry: DeviceConnectionEntry, paneId: string, windowId?: string) {
  if (!windowId) return findWindowForPane(entry, paneId);
  const window = entry.lastSnapshot?.session?.windows.find(
    (candidate) => candidate.id === windowId
  );
  if (!window?.panes.some((pane) => pane.id === paneId)) return undefined;
  return window;
}

function liveWindowGeometry(
  entry: DeviceConnectionEntry,
  windowId: string
): { cols: number; rows: number } | undefined {
  const window = entry.lastSnapshot?.session?.windows.find(
    (candidate) => candidate.id === windowId
  );
  if (!window?.panes.length) return undefined;
  if (window.panes.length > 1) {
    return parseWindowLayoutSize(window.layout) ?? undefined;
  }
  const pane = window.panes[0];
  return pane ? { cols: pane.width, rows: pane.height } : undefined;
}

function pruneMissingWindowViewportState(entry: DeviceConnectionEntry): void {
  const windows = entry.lastSnapshot?.session?.windows;
  if (!windows) return;
  const live = new Set(windows.map((window) => window.id));
  pruneViewportMap(entry.lastAppliedViewport, live);
  pruneViewportMap(entry.lastViewportWinnerId, live);
}

function pruneViewportMap<T>(map: Map<string, T> | undefined, live: Set<string>): void {
  if (!map) return;
  for (const windowId of map.keys()) {
    if (!live.has(windowId)) map.delete(windowId);
  }
}

function collectPolicyClaimants(
  entry: DeviceConnectionEntry,
  extra?: GatewaySession
): Set<GatewaySession> {
  const claimants = new Set<GatewaySession>(entry.clients);
  if (extra) claimants.add(extra);
  return claimants;
}

function syncSnapshotGeometry(
  entry: DeviceConnectionEntry,
  windowId: string,
  cols: number,
  rows: number
): void {
  const window = entry.lastSnapshot?.session?.windows.find(
    (candidate) => candidate.id === windowId
  );
  if (!window) return;
  if (window.panes.length === 1) {
    const pane = window.panes[0];
    if (pane) {
      pane.width = cols;
      pane.height = rows;
    }
  }
  if (window.layout && parseWindowLayoutSize(window.layout)) {
    window.layout = window.layout.replace(/^([0-9a-fA-F]{4},)\d+x\d+/, `$1${cols}x${rows}`);
  }
}

export function applyTermResizeToEntry(
  entry: DeviceConnectionEntry,
  paneId: string,
  cols: number,
  rows: number,
  options: { force?: boolean; windowId?: string } = {}
): void {
  const window = resolveResizeWindow(entry, paneId, options.windowId);
  if (options.windowId && !window) return;
  const force = options.force === true;

  if (window?.panes && window.panes.length > 1) {
    const currentSize = parseWindowLayoutSize(window.layout);
    if (!force && currentSize && currentSize.cols === cols && currentSize.rows === rows) {
      return;
    }
    entry.runtime.resizeWindow(window.id, cols, rows);
    return;
  }

  const pane = window?.panes.find((p) => p.id === paneId);
  if (!force && pane && pane.width === cols && pane.height === rows) {
    return;
  }

  entry.runtime.resizePane(paneId, cols, rows);
}

export function handleTermResize(
  host: TmuxCommandHost,
  session: GatewaySession,
  deviceId: string,
  paneId: string,
  cols: number,
  rows: number
): void {
  recordViewportClaim(
    host,
    session,
    {
      deviceId,
      paneId,
      cols,
      rows,
      visible: true,
    },
    { applyUnknown: true }
  );
}

export function handleTermViewport(
  host: TmuxCommandHost,
  session: GatewaySession,
  decoded: {
    deviceId: string;
    paneId: string;
    cols: number;
    rows: number;
    visible: boolean;
  }
): void {
  recordViewportClaim(host, session, decoded, { applyUnknown: false });
}

function recordViewportClaim(
  host: TmuxCommandHost,
  session: GatewaySession,
  data: {
    deviceId: string;
    paneId: string;
    cols: number;
    rows: number;
    visible: boolean;
  },
  options: { applyUnknown: boolean; skipResize?: boolean }
): ViewportWinner | null {
  const entry = host.connections.get(data.deviceId);
  if (!entry) return null;

  const window = findWindowForPane(entry, data.paneId);
  if (!window) {
    if (options.applyUnknown) {
      applyTermResizeToEntry(entry, data.paneId, data.cols, data.rows);
    }
    return null;
  }

  const key = viewportClaimKey(data.deviceId, window.id);
  const previous = session.viewportClaims.get(key);
  const notifyFirst = !previous || previous.paneId !== data.paneId ? session : undefined;
  session.viewportClaims.set(key, {
    paneId: data.paneId,
    cols: data.cols,
    rows: data.rows,
    visible: data.visible,
    at: Date.now(),
    sentPolicy: previous?.sentPolicy,
  });
  return applyViewportPolicy(host, data.deviceId, window.id, {
    extraSession: session,
    notifyFirst,
    skipResize: options.skipResize,
  });
}

type ViewportPolicyOptions = {
  extraSession?: GatewaySession;
  notifyFirst?: GatewaySession;
  seen?: Set<string>;
  skipResize?: boolean;
};

export function applyViewportPolicy(
  host: TmuxCommandHost,
  deviceId: string,
  windowId: string,
  options: ViewportPolicyOptions = {}
): ViewportWinner | null {
  const entry = host.connections.get(deviceId);
  if (!entry) return null;

  const key = viewportClaimKey(deviceId, windowId);
  const seen = options.seen ?? new Set<string>();
  if (seen.has(key)) return null;
  seen.add(key);

  const claimants = collectPolicyClaimants(entry, options.extraSession);
  const moved = reconcileViewportClaims(
    claimants,
    key,
    windowId,
    (paneId) => findWindowForPane(entry, paneId)?.id ?? null
  );
  pruneMissingWindowViewportState(entry);
  const winner = applyResolvedViewportPolicy(
    host,
    entry,
    deviceId,
    windowId,
    key,
    claimants,
    options
  );

  for (const movedId of moved) {
    applyViewportPolicy(host, deviceId, movedId, {
      extraSession: options.extraSession,
      seen,
    });
  }
  return winner;
}

export function reconcileDeviceViewportSnapshot(host: TmuxCommandHost, deviceId: string): void {
  const entry = host.connections.get(deviceId);
  if (!entry) return;
  const claimants = collectPolicyClaimants(entry);
  const affected = rebindAllViewportClaims(
    claimants,
    deviceId,
    (paneId) => findWindowForPane(entry, paneId)?.id ?? null
  );
  pruneMissingWindowViewportState(entry);
  const seen = new Set<string>();
  for (const windowId of affected) {
    applyViewportPolicy(host, deviceId, windowId, { seen });
  }
}

function applyResolvedViewportPolicy(
  host: TmuxCommandHost,
  entry: DeviceConnectionEntry,
  deviceId: string,
  windowId: string,
  key: string,
  claimants: Set<GatewaySession>,
  options: ViewportPolicyOptions
): ViewportWinner | null {
  const winner = resolveWinner(collectWindowClaims(claimants, key));
  const windowAlive = entry.lastSnapshot?.session?.windows.some((window) => window.id === windowId);
  if (!windowAlive) return winner;
  const lastApplied = entry.lastAppliedViewport?.get(windowId);
  const previousWinnerId = entry.lastViewportWinnerId?.get(windowId) ?? null;
  const nextWinnerId = winner?.sessionId ?? null;
  const geometry = applyWinnerGeometry(winner, liveWindowGeometry(entry, windowId) ?? lastApplied);
  if (geometry) {
    if (!options.skipResize) {
      applyTermResizeToEntry(entry, geometry.paneId, geometry.cols, geometry.rows, {
        force: geometry.force,
        windowId,
      });
    }
    if (!entry.lastAppliedViewport) entry.lastAppliedViewport = new Map();
    entry.lastAppliedViewport.set(windowId, { cols: geometry.cols, rows: geometry.rows });
    syncSnapshotGeometry(entry, windowId, geometry.cols, geometry.rows);
  }

  if (!entry.lastViewportWinnerId) entry.lastViewportWinnerId = new Map();
  entry.lastViewportWinnerId.set(windowId, nextWinnerId);

  const applied = winner ? { cols: winner.claim.cols, rows: winner.claim.rows } : lastApplied;
  if (!applied) return winner;

  notifyClaimants(
    claimants,
    key,
    previousWinnerId !== nextWinnerId || geometry != null,
    options.notifyFirst,
    (session) => ({
      owner: winner?.sessionId === session.id,
      cols: applied.cols,
      rows: applied.rows,
    }),
    (session, claim) => {
      sendViewportPolicy(host, session, {
        deviceId,
        windowId,
        paneId: claim.paneId,
        owner: winner?.sessionId === session.id,
        cols: applied.cols,
        rows: applied.rows,
      });
    }
  );
  return winner;
}

function sendViewportPolicy(
  host: TmuxCommandHost,
  session: GatewaySession,
  payload: {
    deviceId: string;
    windowId: string;
    paneId: string;
    owner: boolean;
    cols: number;
    rows: number;
  }
): void {
  const bytes = wsBorsh.encodePayload(wsBorsh.schema.TermViewportPolicySchema, payload);
  host.sendEnvelope(session, wsBorsh.KIND_TERM_VIEWPORT_POLICY, bytes);
}

export function dropViewportClaims(
  host: TmuxCommandHost,
  session: GatewaySession,
  deviceId?: string,
  options: { recompute?: boolean } = {}
): void {
  const affected = takeViewportClaimKeys(session.viewportClaims, deviceId);
  if (options.recompute === false) return;
  const seen = new Set<string>();
  for (const item of affected) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    applyViewportPolicy(host, item.deviceId, item.windowId);
  }
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
  host.syncLegacyPaneObservers(session, deviceId);
  host.refreshSnapshotPolling(deviceId);
}

export function handleFetchPaneHistory(
  host: TmuxCommandHost,
  session: GatewaySession,
  deviceId: string,
  paneId: string,
  requestToken: Uint8Array,
  byteLimit?: number | null
): void {
  const entry = host.connections.get(deviceId);
  if (!entry || !isTmuxPaneId(paneId)) return;
  const limit =
    byteLimit != null && Number.isSafeInteger(byteLimit) && byteLimit > 0
      ? Math.min(byteLimit, MAX_PANE_HISTORY_CAPTURE_BYTES)
      : MAX_PANE_HISTORY_CAPTURE_BYTES;

  void entry.runtime
    .fetchPaneHistory(paneId, limit)
    .then((captured) => {
      if (!captured) return;
      const encoded = new TextEncoder().encode(captured.data);
      const data = encoded.byteLength <= limit ? encoded : truncateUtf8Tail(encoded, limit);
      const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.TermHistorySchema, {
        deviceId,
        paneId,
        selectToken: requestToken,
        encoding: 1,
        alternateScreen: captured.alternateScreen,
        modes: captured.modes,
        data,
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
  host.syncLegacyPaneObservers(session, deviceId);
  host.refreshSnapshotPolling(deviceId);
  entry.runtime.focusPane(windowId, paneId);
}
