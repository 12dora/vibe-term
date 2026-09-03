import { wsBorsh } from '@tmex/shared';
import { isTmuxPaneId } from '../tmux-client/snapshot-format';
import { parseWindowLayoutSize } from './frame-utils';
import type { GatewaySession } from './gateway-session';
import type { TmuxCommandHost } from './tmux-command-handlers';
import type { DeviceConnectionEntry } from './types';
import {
  type ViewportWinner,
  applyWinnerGeometry,
  collectWindowClaims,
  liveWindowGeometry,
  notifyClaimants,
  rebindAllViewportClaims,
  reconcileViewportClaims,
  resolveWinner,
  takeViewportClaimKeys,
  viewportClaimKey,
} from './viewport-policy';

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

export function recordViewportClaim(
  host: TmuxCommandHost,
  session: GatewaySession,
  data: {
    deviceId: string;
    paneId: string;
    cols: number;
    rows: number;
    visible: boolean;
  },
  options: { applyUnknown: boolean; skipResize?: boolean; distrustLive?: boolean }
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
    distrustLive: options.distrustLive,
  });
}

type ViewportPolicyOptions = {
  extraSession?: GatewaySession;
  notifyFirst?: GatewaySession;
  seen?: Set<string>;
  skipResize?: boolean;
  // 暖切换（wantHistory=false）时不信任快照几何：该窗口可能自上次快照后已在 tmux 侧漂移。
  distrustLive?: boolean;
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
  const geometry = applyWinnerGeometry(
    winner,
    lastApplied,
    options.distrustLive ? undefined : liveWindowGeometry(entry, windowId)
  );
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
