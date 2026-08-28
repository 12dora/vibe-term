import { describe, expect, test } from 'bun:test';
import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import { buildPaneActions, buildWindowActions } from './device-tree-actions';

const t = (key: string) => key;

function pane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    id: '%1',
    windowId: '@1',
    index: 0,
    active: true,
    width: 80,
    height: 24,
    ...overrides,
  };
}

function tmuxWindow(panes: TmuxPane[]): TmuxWindow {
  return { id: '@1', name: 'one', index: 0, active: true, panes };
}

const noopHandlers = {
  onRename: () => {},
  onCreateWindowInCwd: () => {},
  onSplit: () => {},
  onWatch: () => {},
  onClose: () => {},
};

const keysOf = (items: { key: string }[]) => items.map((item) => item.key);

describe('buildWindowActions', () => {
  test('renders the full menu for a window with an active pane', () => {
    const items = buildWindowActions({
      t,
      tmuxWindow: tmuxWindow([pane({ currentPath: '/srv' })]),
      watchUi: true,
      ...noopHandlers,
      onCreateSession: () => {},
    });
    expect(keysOf(items)).toEqual([
      'rename',
      'new-session',
      'new-in-cwd',
      'split-right',
      'split-down',
      'watch',
      'close',
    ]);
    expect(items.map((item) => item.testId)).toEqual([
      'window-menu-rename-@1',
      'window-menu-new-session-@1',
      undefined,
      'window-menu-split-right-@1',
      'window-menu-split-down-@1',
      'window-menu-watch-@1',
      'window-menu-close-@1',
    ]);
  });

  test('drops split/watch and keeps rename/close for a window with zero panes', () => {
    const items = buildWindowActions({
      t,
      tmuxWindow: tmuxWindow([]),
      watchUi: true,
      ...noopHandlers,
      onCreateSession: undefined,
    });
    expect(keysOf(items)).toEqual(['rename', 'close']);
  });

  test('omits the agent session item when no session target exists', () => {
    const withAgent = buildWindowActions({
      t,
      tmuxWindow: tmuxWindow([pane()]),
      watchUi: false,
      ...noopHandlers,
      onCreateSession: () => {},
    });
    expect(keysOf(withAgent)).toContain('new-session');

    const withoutAgent = buildWindowActions({
      t,
      tmuxWindow: tmuxWindow([pane()]),
      watchUi: false,
      ...noopHandlers,
    });
    expect(keysOf(withoutAgent)).not.toContain('new-session');
  });

  test('omits new-in-cwd when the active pane has no cwd and hides watch without the feature', () => {
    const items = buildWindowActions({
      t,
      tmuxWindow: tmuxWindow([pane()]),
      watchUi: false,
      ...noopHandlers,
    });
    expect(keysOf(items)).toEqual(['rename', 'split-right', 'split-down', 'close']);
  });

  test('splits from the active pane, not the first one', () => {
    const calls: string[] = [];
    const items = buildWindowActions({
      t,
      tmuxWindow: tmuxWindow([
        pane({ id: '%1', active: false }),
        pane({ id: '%2', active: true, currentPath: '/tmp' }),
      ]),
      watchUi: true,
      ...noopHandlers,
      onSplit: (paneId, direction, cwd) => calls.push(`${paneId}:${direction}:${cwd}`),
      onWatch: (paneId) => calls.push(`watch:${paneId}`),
    });
    for (const item of items) item.onSelect();
    expect(calls).toEqual(['%2:right:/tmp', '%2:down:/tmp', 'watch:%2']);
  });
});

describe('buildPaneActions', () => {
  test('renders the full menu with pane-scoped test ids', () => {
    const items = buildPaneActions({
      t,
      pane: pane({ id: '%7', currentPath: '/home' }),
      watchUi: true,
      ...noopHandlers,
      onCreateSession: () => {},
    });
    expect(keysOf(items)).toEqual([
      'rename',
      'new-session',
      'new-in-cwd',
      'split-right',
      'split-down',
      'watch',
      'close',
    ]);
    expect(items.map((item) => item.testId)).toEqual([
      'pane-menu-rename-%7',
      'pane-menu-new-session-%7',
      undefined,
      'pane-split-right-%7',
      'pane-split-down-%7',
      'pane-watch-%7',
      'pane-menu-close-%7',
    ]);
  });

  test('always keeps split available even without a cwd', () => {
    const items = buildPaneActions({
      t,
      pane: pane({ id: '%7' }),
      watchUi: false,
      ...noopHandlers,
    });
    expect(keysOf(items)).toEqual(['rename', 'split-right', 'split-down', 'close']);
  });

  test('forwards the pane cwd to new-in-cwd and split', () => {
    const calls: string[] = [];
    const items = buildPaneActions({
      t,
      pane: pane({ id: '%7', currentPath: '/var' }),
      watchUi: false,
      ...noopHandlers,
      onCreateWindowInCwd: (cwd) => calls.push(`cwd:${cwd}`),
      onSplit: (paneId, direction, cwd) => calls.push(`${paneId}:${direction}:${cwd}`),
    });
    for (const item of items) item.onSelect();
    expect(calls).toEqual(['cwd:/var', '%7:right:/var', '%7:down:/var']);
  });
});
