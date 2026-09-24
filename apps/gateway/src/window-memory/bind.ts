import type { TmuxWindow } from '@vibeterm/shared';

import type { TmuxConnectionOptions } from '../tmux-client/connection-types';
import { getAppliedTripleBook } from './applied-triples';
import { type WindowMemoryTrackerHandle, createWindowMemoryTracker } from './tracker';
import type { HostShellRunner } from './types';

export interface WindowMemoryBindHost extends HostShellRunner {
  deviceId: string;
  snapshotWindows: Map<string, TmuxWindow>;
}

export function paneIdsFromWindows(windows: Map<string, TmuxWindow>): string[] {
  const ids: string[] = [];
  for (const window of windows.values()) {
    for (const pane of window.panes) ids.push(pane.id);
  }
  ids.sort();
  return ids;
}

export function panesFromWindows(windows: Map<string, TmuxWindow>) {
  const panes: Array<{ paneId: string; windowId: string; windowName: string; pid?: number }> = [];
  for (const window of windows.values()) {
    for (const pane of window.panes) {
      panes.push({
        paneId: pane.id,
        windowId: window.id,
        windowName: window.name,
        pid: pane.pid,
      });
    }
  }
  return panes;
}

export function samePaneIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

export function bindWindowMemoryTracker(
  deviceId: string,
  host: HostShellRunner,
  snapshotWindows: Map<string, TmuxWindow>,
  options: TmuxConnectionOptions
): WindowMemoryTrackerHandle | null {
  if (!options.windowMemory) return null;
  return createWindowMemoryTracker({
    deviceId,
    host,
    hooks: options.windowMemory,
    getPanes: () => panesFromWindows(snapshotWindows),
    appliedTriples: getAppliedTripleBook(),
  });
}

export function onWindowMemorySnapshot(
  tracker: WindowMemoryTrackerHandle | null,
  started: { value: boolean },
  prevIds: string[],
  windows: Map<string, TmuxWindow>
): void {
  if (!tracker) return;
  if (!started.value) {
    started.value = true;
    tracker.start();
    return;
  }
  if (!samePaneIds(prevIds, paneIdsFromWindows(windows))) tracker.requestTickSoon();
}
