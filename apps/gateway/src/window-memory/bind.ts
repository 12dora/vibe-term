import type { TmuxWindow } from '@vibeterm/shared';

import type { TmuxConnectionOptions } from '../tmux-client/connection-types';
import { type CgroupPlacement, getCgroupPlacement } from '../tmux/cgroup-placement';
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

/** 返回值是本次 pane 归位的完成信号，调用方可以不等；测试据此确定性地等待。 */
export function onWindowMemorySnapshot(
  tracker: WindowMemoryTrackerHandle | null,
  started: { value: boolean },
  prevIds: string[],
  windows: Map<string, TmuxWindow>,
  placement: CgroupPlacement = getCgroupPlacement()
): Promise<void> {
  if (!tracker) return Promise.resolve();
  if (!started.value) {
    started.value = true;
    tracker.start();
    return placeSnapshotPanes(tracker, windows, placement);
  }
  if (samePaneIds(prevIds, paneIdsFromWindows(windows))) return Promise.resolve();
  tracker.requestTickSoon();
  return placeSnapshotPanes(tracker, windows, placement);
}

/** 新 pane 搬进 workload scope 后再采一次，限额 / stop 才会落到新 scope 上。 */
async function placeSnapshotPanes(
  tracker: WindowMemoryTrackerHandle,
  windows: Map<string, TmuxWindow>,
  placement: CgroupPlacement
): Promise<void> {
  if (!placement.isDeviceEnabled(tracker.deviceId)) return;
  const pids = panesFromWindows(windows).flatMap((pane) => (pane.pid ? [pane.pid] : []));
  const moved = await placement.placePanes(tracker.deviceId, pids);
  if (moved > 0) tracker.requestTickSoon();
}
