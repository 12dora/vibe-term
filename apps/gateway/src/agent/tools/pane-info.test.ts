import { describe, expect, test } from 'bun:test';
import type { PaneInfo } from '../../tmux-client/capture-history';
import { overlaySnapshotFields } from './pane-info';

function info(overrides: Partial<PaneInfo> = {}): PaneInfo {
  return {
    cols: 80,
    rows: 24,
    cursorX: 0,
    cursorY: 0,
    alternateScreen: false,
    currentCommand: 'bash',
    ...overrides,
  };
}

const snapshot = {
  title: 'snap-title',
  currentPath: '/snap',
  windowName: 'snap-win',
  windowId: '@s',
  sessionId: '$s',
  sessionName: 'snap-sess',
  splitPaneCount: 3,
};

describe('overlaySnapshotFields', () => {
  test('live pane 字段优先于 snapshot', () => {
    expect(
      overlaySnapshotFields(
        info({
          title: 'live',
          currentPath: '/live',
          windowName: 'w',
          windowId: '@1',
          sessionId: '$1',
          sessionName: 'sess',
          splitPaneCount: 2,
        }),
        snapshot
      )
    ).toEqual({
      title: 'live',
      currentPath: '/live',
      windowName: 'w',
      windowId: '@1',
      sessionId: '$1',
      sessionName: 'sess',
      splitPaneCount: 2,
    });
  });

  test('live 缺省时回落到 snapshot，再缺省为 null', () => {
    expect(overlaySnapshotFields(info(), snapshot)).toEqual(snapshot);
    expect(overlaySnapshotFields(info(), null)).toEqual({
      title: null,
      currentPath: null,
      windowName: null,
      windowId: null,
      sessionId: null,
      sessionName: null,
      splitPaneCount: null,
    });
  });

  test('splitPaneCount=0 视为有效 live 值，不回落 snapshot', () => {
    expect(overlaySnapshotFields(info({ splitPaneCount: 0 }), snapshot).splitPaneCount).toBe(0);
  });
});
