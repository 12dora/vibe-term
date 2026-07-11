import { describe, expect, test } from 'bun:test';
import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import { diffSnapshotClosures } from './snapshot-diff';

function makePane(id: string, windowId: string, index = 0, title = `title-${id}`): TmuxPane {
  return {
    id,
    windowId,
    index,
    title,
    currentCommand: `cmd-${id}`,
    currentPath: '/tmp',
    active: false,
    width: 80,
    height: 24,
    left: 0,
    top: 0,
  };
}

function makeWindow(id: string, panes: TmuxPane[], index = 0): TmuxWindow {
  return { id, index, name: `win-${id}`, active: false, layout: 'layout', panes };
}

function toMap(windows: TmuxWindow[]): Map<string, TmuxWindow> {
  return new Map(windows.map((window) => [window.id, window]));
}

describe('diffSnapshotClosures', () => {
  test('window removal reports the window without per-pane events', () => {
    const prev = toMap([
      makeWindow('@1', [makePane('%1', '@1'), makePane('%2', '@1', 1)]),
      makeWindow('@2', [makePane('%3', '@2')], 1),
    ]);
    const next = toMap([makeWindow('@2', [makePane('%3', '@2')], 1)]);

    const { closedWindows, closedPanes } = diffSnapshotClosures(prev, next);
    expect(closedWindows.map((w) => w.id)).toEqual(['@1']);
    expect(closedPanes).toHaveLength(0);
  });

  test('pane removal within a surviving window reports pane with prev metadata', () => {
    const prev = toMap([
      makeWindow('@1', [makePane('%1', '@1'), makePane('%2', '@1', 1, 'vim session')]),
    ]);
    const next = toMap([makeWindow('@1', [makePane('%1', '@1')])]);

    const { closedWindows, closedPanes } = diffSnapshotClosures(prev, next);
    expect(closedWindows).toHaveLength(0);
    expect(closedPanes).toHaveLength(1);
    expect(closedPanes[0]?.pane.id).toBe('%2');
    expect(closedPanes[0]?.pane.title).toBe('vim session');
    expect(closedPanes[0]?.pane.currentCommand).toBe('cmd-%2');
    expect(closedPanes[0]?.window.id).toBe('@1');
  });

  test('unchanged and newly added windows/panes report nothing', () => {
    const prev = toMap([makeWindow('@1', [makePane('%1', '@1')])]);
    const next = toMap([
      makeWindow('@1', [makePane('%1', '@1'), makePane('%9', '@1', 1)]),
      makeWindow('@5', [makePane('%5', '@5')], 1),
    ]);

    const { closedWindows, closedPanes } = diffSnapshotClosures(prev, next);
    expect(closedWindows).toHaveLength(0);
    expect(closedPanes).toHaveLength(0);
  });

  test('mixed: one window closes entirely while another loses a pane', () => {
    const prev = toMap([
      makeWindow('@1', [makePane('%1', '@1')]),
      makeWindow('@2', [makePane('%2', '@2'), makePane('%3', '@2', 1)], 1),
    ]);
    const next = toMap([makeWindow('@2', [makePane('%2', '@2')], 1)]);

    const { closedWindows, closedPanes } = diffSnapshotClosures(prev, next);
    expect(closedWindows.map((w) => w.id)).toEqual(['@1']);
    expect(closedPanes.map((entry) => entry.pane.id)).toEqual(['%3']);
  });
});
