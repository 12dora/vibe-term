import { type Tool, tool } from 'ai';
import { z } from 'zod';
import type { PaneInfo } from '../../tmux-client/capture-history';
import { getDeviceSnapshot } from '../../tmux/snapshot-directory';
import {
  type TerminalToolContext,
  checkRuntimeAlive,
  failTool,
  liveEmulator,
  toToolErrorMessage,
} from './terminal-context';

export interface SnapshotPaneContext {
  title: string | null;
  currentPath: string | null;
  windowName: string | null;
  windowId: string | null;
  sessionId: string | null;
  sessionName: string | null;
  splitPaneCount: number | null;
}

export type PaneSnapshotLookup =
  | { found: true; context: SnapshotPaneContext }
  | { found: false; snapshotExists: boolean };

export function findPaneInSnapshot(deviceId: string, paneId: string): PaneSnapshotLookup {
  const snapshot = getDeviceSnapshot(deviceId);
  const session = snapshot?.session;
  if (!snapshot || !session) {
    return { found: false, snapshotExists: false };
  }
  for (const window of session.windows) {
    const pane = window.panes.find((p) => p.id === paneId);
    if (pane) {
      return {
        found: true,
        context: {
          title: pane.title ?? null,
          currentPath: pane.currentPath ?? null,
          windowName: window.name ?? null,
          windowId: window.id ?? null,
          sessionId: session.id,
          sessionName: session.name,
          splitPaneCount: window.panes.length,
        },
      };
    }
  }
  return { found: false, snapshotExists: true };
}

function overlaySnapshotFields(
  info: PaneInfo,
  snapshot: SnapshotPaneContext | null
): SnapshotPaneContext {
  return {
    title: info.title ?? snapshot?.title ?? null,
    currentPath: info.currentPath ?? snapshot?.currentPath ?? null,
    windowName: info.windowName ?? snapshot?.windowName ?? null,
    windowId: info.windowId ?? snapshot?.windowId ?? null,
    sessionId: info.sessionId ?? snapshot?.sessionId ?? null,
    sessionName: info.sessionName ?? snapshot?.sessionName ?? null,
    splitPaneCount: info.splitPaneCount ?? snapshot?.splitPaneCount ?? null,
  };
}

function formatPaneInfo(
  info: PaneInfo,
  snapshot: SnapshotPaneContext | null,
  alternateScreen: boolean
) {
  return {
    ...info,
    alternateScreen,
    ...overlaySnapshotFields(info, snapshot),
    term: info.term ?? process.env.TERM ?? null,
    termProgram: info.termProgram ?? process.env.TERM_PROGRAM ?? null,
    locale: info.locale ?? process.env.LANG ?? process.env.LC_ALL ?? null,
    encoding: info.encoding ?? 'utf-8',
    capturedAt: new Date().toISOString(),
  };
}

export function createGetPaneInfoTool(ctx: TerminalToolContext): Tool {
  return tool({
    description:
      'Get live metadata of the bound tmux pane: size (cols/rows), cursor position, whether the alternate screen is active (a full-screen TUI like vim/less), the current foreground command, plus pane context (title, current path, tmux session/window, split-pane count) and entry-host terminal/locale/encoding. Use it to understand TUI state, how output wraps, and confirm the pane still exists.',
    inputSchema: z.object({}),
    execute: async () => {
      const aliveError = checkRuntimeAlive(ctx);
      if (aliveError) return aliveError;
      const runtime = ctx.getRuntime();
      if (!runtime) return failTool(ctx, 'Terminal connection is not available.');
      try {
        const info = await runtime.getPaneInfo(ctx.paneId);
        const emulator = liveEmulator(ctx);
        const alternateScreen = emulator ? emulator.isAlternateScreen() : info.alternateScreen;
        const lookup =
          runtime.findPaneInSnapshot?.(ctx.paneId) ?? findPaneInSnapshot(ctx.deviceId, ctx.paneId);
        if (!lookup.found && lookup.snapshotExists) {
          return failTool(ctx, 'Bound pane no longer exists in snapshot.');
        }
        ctx.onSuccess();
        return formatPaneInfo(info, lookup.found ? lookup.context : null, alternateScreen);
      } catch (error) {
        return failTool(ctx, `Failed to read pane info: ${toToolErrorMessage(error)}`);
      }
    },
  });
}
