import { describe, expect, test } from 'bun:test';
import type { TmuxWindow } from '@vibeterm/shared';

import type { CgroupPlacement } from '../tmux/cgroup-placement';
import { onWindowMemorySnapshot, paneIdsFromWindows } from './bind';
import type { WindowMemoryTrackerHandle } from './tracker';

function windows(panes: Array<{ id: string; pid?: number }>): Map<string, TmuxWindow> {
  return new Map([['@1', { id: '@1', name: 'w', panes } as unknown as TmuxWindow]]);
}

function fakeTracker() {
  const calls: string[] = [];
  const tracker = {
    deviceId: 'dev-1',
    start: () => calls.push('start'),
    requestTickSoon: () => calls.push('tick'),
  } as unknown as WindowMemoryTrackerHandle;
  return { tracker, calls };
}

function fakePlacement(enabled: boolean, moved: number) {
  const placed: number[][] = [];
  const placement = {
    isDeviceEnabled: () => enabled,
    placePanes: async (_id: string, pids: number[]) => {
      placed.push(pids);
      return moved;
    },
  } as unknown as CgroupPlacement;
  return { placement, placed };
}

describe('onWindowMemorySnapshot placement', () => {
  test('places pane pids on start and on pane-set change, re-ticks after a move', async () => {
    const { tracker, calls } = fakeTracker();
    const { placement, placed } = fakePlacement(true, 1);
    const started = { value: false };
    const first = windows([{ id: '%1', pid: 10 }]);
    await onWindowMemorySnapshot(tracker, started, [], first, placement);
    expect(placed).toEqual([[10]]);
    expect(calls).toEqual(['start', 'tick']);

    await onWindowMemorySnapshot(tracker, started, paneIdsFromWindows(first), first, placement);
    expect(placed).toHaveLength(1);

    const next = windows([{ id: '%1', pid: 10 }, { id: '%2', pid: 11 }, { id: '%3' }]);
    await onWindowMemorySnapshot(tracker, started, paneIdsFromWindows(first), next, placement);
    expect(placed).toEqual([[10], [10, 11]]);
    expect(calls).toEqual(['start', 'tick', 'tick', 'tick']);
  });

  test('disabled device places nothing and does not re-tick', async () => {
    const { tracker, calls } = fakeTracker();
    const { placement, placed } = fakePlacement(false, 1);
    await onWindowMemorySnapshot(
      tracker,
      { value: false },
      [],
      windows([{ id: '%1', pid: 10 }]),
      placement
    );
    expect(placed).toEqual([]);
    expect(calls).toEqual(['start']);
  });
});
