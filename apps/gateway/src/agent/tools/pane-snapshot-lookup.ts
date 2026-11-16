import { getDeviceSnapshot } from '../../tmux/snapshot-directory';

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
