import type { TmuxPane, TmuxSession, TmuxWindow } from '@tmex/shared';

import type { TmuxConnectionOptions } from '../connection-types';
import type { ControlModeSubscription } from '../control-mode-subscription';
import type { ConnectionLifecycleEmitter } from '../lifecycle-emitter';
import {
  PANE_SNAPSHOT_FORMAT,
  SNAPSHOT_FIELD_SEPARATOR,
  WINDOW_SNAPSHOT_FORMAT,
  formatSnapshotRowForLog,
  isTmuxSessionId,
  parsePaneSnapshotRow,
  parseWindowSnapshotRow,
  splitSnapshotFields,
} from '../snapshot-format';
import { isTmuxServerGoneMessage } from './helpers';
import type { CommandResult } from './types';

export interface SnapshotLogContext {
  logPrefix: string;
  deviceId: string;
  warn?: (message: string) => void;
}

export interface SnapshotEmitHost {
  deviceId: string;
  snapshotSession: Pick<TmuxSession, 'id' | 'name'> | null;
  snapshotWindows: Map<string, TmuxWindow>;
  callbacks: Pick<TmuxConnectionOptions, 'onSnapshot'>;
}

export interface SnapshotProjectorHost {
  connected: boolean;
  connectGeneration: number;
  manualDisconnect: boolean;
  deviceId: string;
  sessionName: string;
  logPrefix: string;
  snapshotSession: Pick<TmuxSession, 'id' | 'name'> | null;
  snapshotWindows: Map<string, TmuxWindow>;
  activeWindowId: string | null;
  activePaneId: string | null;
  controlSubscription: Pick<ControlModeSubscription, 'prunePanes'> | null;
  callbacks: TmuxConnectionOptions;
  lifecycle: Pick<ConnectionLifecycleEmitter, 'emitSnapshotClosures' | 'notifySessionClosed'>;
  runTmuxAllowFailure(argv: string[], timeoutMs?: number): Promise<CommandResult>;
  shouldAbortSnapshot(results: CommandResult[]): boolean;
  onSnapshotSuccess(): void;
  pruneThemeSubscriptions(paneIds: ReadonlySet<string>): void;
  restoreThemeSubscriptionsOnce(): void;
  markDeviceTmuxUnavailable(message: string): void;
  shutdownInternal(notifyClose: boolean): Promise<void>;
}

function writeWarn(ctx: SnapshotLogContext, message: string): void {
  (ctx.warn ?? console.warn)(message);
}

export function parseSnapshotSession(
  lines: string[],
  ctx: SnapshotLogContext
): Pick<TmuxSession, 'id' | 'name'> | null {
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const [id, name] = splitSnapshotFields(line, 2);
    if (isTmuxSessionId(id)) {
      return { id, name: name ?? '' };
    }
    writeWarn(
      ctx,
      `${ctx.logPrefix} ignoring invalid tmux session id on ${ctx.deviceId}: ${id ?? ''}`
    );
    return null;
  }
  return null;
}

export function parseSnapshotWindows(
  lines: string[],
  ctx: SnapshotLogContext
): { windows: Map<string, TmuxWindow>; activeWindowId?: string } {
  const windows = new Map<string, TmuxWindow>();
  let activeWindowId: string | undefined;
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const row = parseWindowSnapshotRow(line);
    if (!row) {
      writeWarn(
        ctx,
        `${ctx.logPrefix} ignoring invalid tmux window snapshot row on ${ctx.deviceId}: ${formatSnapshotRowForLog(line)}`
      );
      continue;
    }
    if (row.active) {
      activeWindowId = row.id;
    }
    windows.set(row.id, {
      id: row.id,
      index: row.index,
      name: row.name,
      active: row.active,
      layout: row.layout,
      panes: [],
    });
  }
  return { windows, activeWindowId };
}

export function parseSnapshotPanes(
  lines: string[],
  windows: Map<string, TmuxWindow>,
  ctx: SnapshotLogContext
): { activePaneId?: string; activeWindowId?: string } {
  for (const window of windows.values()) {
    window.panes = [];
  }

  let activePaneId: string | undefined;
  let activeWindowId: string | undefined;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const row = parsePaneSnapshotRow(line);
    if (!row) {
      writeWarn(
        ctx,
        `${ctx.logPrefix} ignoring invalid tmux pane snapshot row on ${ctx.deviceId}: ${formatSnapshotRowForLog(line)}`
      );
      continue;
    }
    const pane: TmuxPane = {
      id: row.id,
      windowId: row.windowId,
      index: row.index,
      title: row.title ?? '',
      currentCommand: row.currentCommand,
      currentPath: row.currentPath,
      active: row.active,
      width: row.width,
      height: row.height,
      left: row.left,
      top: row.top,
    };

    if (pane.active && row.windowActive) {
      activePaneId = row.id;
      activeWindowId = row.windowId;
    }

    const window = windows.get(row.windowId);
    if (!window) {
      continue;
    }
    window.panes.push(pane);
  }

  for (const window of windows.values()) {
    window.panes.sort((left, right) => left.index - right.index);
  }

  return { activePaneId, activeWindowId };
}

export function discardInvalidSnapshot(
  session: Pick<TmuxSession, 'id' | 'name'> | null,
  windows: Map<string, TmuxWindow>,
  ctx: SnapshotLogContext,
  activeWindowId: string | null,
  activePaneId: string | null
): {
  session: Pick<TmuxSession, 'id' | 'name'> | null;
  windows: Map<string, TmuxWindow>;
  activeWindowId: string | null;
  activePaneId: string | null;
} {
  if (!session) {
    windows.clear();
    return { session: null, windows, activeWindowId: null, activePaneId: null };
  }

  if (windows.size === 0) {
    writeWarn(
      ctx,
      `${ctx.logPrefix} ignoring tmux snapshot with no valid windows on ${ctx.deviceId}`
    );
    return { session: null, windows, activeWindowId: null, activePaneId: null };
  }

  return { session, windows, activeWindowId, activePaneId };
}

export function windowsInIndexOrder(
  windows: Map<string, TmuxWindow> | readonly TmuxWindow[]
): TmuxWindow[] {
  const list = windows instanceof Map ? Array.from(windows.values()) : [...windows];
  return list.sort((left, right) => left.index - right.index);
}

export function getExpectedPaneIds(
  windows: Map<string, TmuxWindow> | readonly TmuxWindow[]
): string[] {
  const ordered = windows instanceof Map ? windowsInIndexOrder(windows) : windows;
  return ordered.flatMap((window) => window.panes.map((pane) => pane.id));
}

export function emitSnapshot(
  host: SnapshotEmitHost,
  baseRevision?: bigint,
  orderedWindows?: readonly TmuxWindow[]
): void {
  const session = host.snapshotSession
    ? {
        id: host.snapshotSession.id,
        name: host.snapshotSession.name,
        windows: orderedWindows ? [...orderedWindows] : windowsInIndexOrder(host.snapshotWindows),
      }
    : null;

  host.callbacks.onSnapshot(
    {
      deviceId: host.deviceId,
      session,
    },
    baseRevision
  );
}

export class SnapshotProjector {
  constructor(private readonly host: SnapshotProjectorHost) {}

  private hostStillAcceptsSnapshot(generation: number): boolean {
    const host = this.host;
    return host.connected && host.connectGeneration === generation;
  }

  private fetchSnapshotResults(): Promise<[CommandResult, CommandResult, CommandResult]> {
    const host = this.host;
    return Promise.all([
      host.runTmuxAllowFailure([
        'display-message',
        '-p',
        '-t',
        host.sessionName,
        ['#{session_id}', '#{session_name}'].join(SNAPSHOT_FIELD_SEPARATOR),
      ]),
      host.runTmuxAllowFailure([
        'list-windows',
        '-t',
        host.sessionName,
        '-F',
        WINDOW_SNAPSHOT_FORMAT,
      ]),
      host.runTmuxAllowFailure([
        'list-panes',
        '-s',
        '-t',
        host.sessionName,
        '-F',
        PANE_SNAPSHOT_FORMAT,
      ]),
    ]);
  }

  async performSnapshot(): Promise<void> {
    const host = this.host;
    if (!host.connected) {
      return;
    }
    const generation = host.connectGeneration;

    const baseRevision = host.callbacks.beginMetadataReconcile?.();
    const [sessionRes, windowsRes, panesRes] = await this.fetchSnapshotResults();

    if (!this.hostStillAcceptsSnapshot(generation)) {
      return;
    }

    if (host.shouldAbortSnapshot([sessionRes, windowsRes, panesRes])) {
      return;
    }

    if (sessionRes.exitCode !== 0 || windowsRes.exitCode !== 0 || panesRes.exitCode !== 0) {
      this.handleSnapshotCommandFailure(sessionRes, windowsRes, panesRes);
      return;
    }

    const prevWindows = new Map(host.snapshotWindows);
    this.applyParsedSnapshot(
      sessionRes.stdout.split(/\r?\n/),
      windowsRes.stdout.split(/\r?\n/),
      panesRes.stdout.split(/\r?\n/)
    );
    const orderedWindows = windowsInIndexOrder(host.snapshotWindows);
    const expectedPaneIds = new Set(getExpectedPaneIds(orderedWindows));
    host.controlSubscription?.prunePanes(expectedPaneIds);
    host.pruneThemeSubscriptions(expectedPaneIds);
    host.restoreThemeSubscriptionsOnce();
    host.onSnapshotSuccess();
    emitSnapshot(host, baseRevision, orderedWindows);
    host.lifecycle.emitSnapshotClosures(prevWindows);
  }

  private applyParsedSnapshot(
    sessionLines: string[],
    windowLines: string[],
    paneLines: string[]
  ): void {
    const host = this.host;
    const ctx: SnapshotLogContext = { logPrefix: host.logPrefix, deviceId: host.deviceId };
    host.snapshotSession = parseSnapshotSession(sessionLines, ctx);
    const parsedWindows = parseSnapshotWindows(windowLines, ctx);
    host.snapshotWindows.clear();
    for (const [id, window] of parsedWindows.windows) {
      host.snapshotWindows.set(id, window);
    }
    if (parsedWindows.activeWindowId !== undefined) {
      host.activeWindowId = parsedWindows.activeWindowId;
    }
    const paneUpdate = parseSnapshotPanes(paneLines, host.snapshotWindows, ctx);
    if (paneUpdate.activePaneId !== undefined) {
      host.activePaneId = paneUpdate.activePaneId;
    }
    if (paneUpdate.activeWindowId !== undefined) {
      host.activeWindowId = paneUpdate.activeWindowId;
    }
    const discarded = discardInvalidSnapshot(
      host.snapshotSession,
      host.snapshotWindows,
      ctx,
      host.activeWindowId,
      host.activePaneId
    );
    host.snapshotSession = discarded.session;
    host.activeWindowId = discarded.activeWindowId;
    host.activePaneId = discarded.activePaneId;
  }

  private handleSnapshotCommandFailure(
    sessionRes: CommandResult,
    windowsRes: CommandResult,
    panesRes: CommandResult
  ): void {
    const host = this.host;
    const stderrBlob = `${sessionRes.stderr}\n${windowsRes.stderr}\n${panesRes.stderr}`;
    if (host.connected && !host.manualDisconnect && isTmuxServerGoneMessage(stderrBlob)) {
      const message =
        stderrBlob
          .trim()
          .split(/\r?\n/)
          .find((line) => line.trim())
          ?.trim() ?? 'tmux server gone';
      console.warn(
        `${host.logPrefix} tmux server gone during snapshot on ${host.deviceId}: ${message}`
      );
      host.markDeviceTmuxUnavailable(message);
      host.lifecycle.notifySessionClosed(message);
      void host.shutdownInternal(true);
      return;
    }
    host.callbacks.onSnapshot({ deviceId: host.deviceId, session: null });
  }
}
