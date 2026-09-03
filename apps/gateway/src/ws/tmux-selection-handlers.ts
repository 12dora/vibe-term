import type { wsBorsh } from '@tmex/shared';
import { isTmuxPaneId, isTmuxWindowId } from '../tmux-client/snapshot-format';
import type { GatewaySession } from './gateway-session';
import type { TmuxCommandHost } from './tmux-command-handlers';
import { recordViewportClaim } from './tmux-geometry-handlers';
import type { DeviceConnectionEntry } from './types';
import { type ViewportWinner, liveWindowGeometry } from './viewport-policy';

export { findWindowForPane } from './tmux-geometry-handlers';

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

  host.refreshSnapshotPolling(deviceId);
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
