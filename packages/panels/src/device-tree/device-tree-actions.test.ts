import { describe, expect, test } from 'bun:test';
import type { TmuxPane } from '@tmex/shared';
import type { ComponentType } from 'react';
import type { DeviceTreeNavigation, SidebarAgentAdapter } from './agent-adapter';
import { type SharedPaneActionContext, buildSharedPaneActionItems } from './device-tree-actions';

function makePane(overrides: Partial<TmuxPane> = {}): TmuxPane {
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

const nav: DeviceTreeNavigation = { navigateToPane: () => {} };
const NullComponent: ComponentType<never> = () => null;

interface SessionCall {
  deviceId: string;
  windowId: string;
  paneId: string;
}

function makeAgent(calls: SessionCall[]): SidebarAgentAdapter {
  return {
    onCreateSessionForPane: (_nav, deviceId, windowId, pane) =>
      calls.push({ deviceId, windowId, paneId: pane.id }),
    PaneSessions: NullComponent as SidebarAgentAdapter['PaneSessions'],
    OrphanSessions: NullComponent as SidebarAgentAdapter['OrphanSessions'],
    Dialogs: NullComponent as SidebarAgentAdapter['Dialogs'],
  };
}

interface Recorded {
  createWindow: Array<[string, string | undefined, string]>;
  splitPane: Array<[string, string, 'right' | 'down', string | undefined]>;
  watch: Array<[string, string]>;
  session: SessionCall[];
}

function makeContext(overrides: Partial<SharedPaneActionContext> = {}): {
  ctx: SharedPaneActionContext;
  recorded: Recorded;
} {
  const recorded: Recorded = { createWindow: [], splitPane: [], watch: [], session: [] };
  const ctx: SharedPaneActionContext = {
    deviceId: 'dev-1',
    windowId: '@1',
    pane: makePane({ currentPath: '/home/dev' }),
    sessionPane: makePane(),
    agent: makeAgent(recorded.session),
    nav,
    watchUi: true,
    testIds: {
      newSession: 'ts-new-session',
      splitRight: 'ts-split-right',
      splitDown: 'ts-split-down',
      watch: 'ts-watch',
    },
    t: (key) => key,
    createWindow: (deviceId, name, cwd) => recorded.createWindow.push([deviceId, name, cwd]),
    splitPane: (deviceId, paneId, direction, cwd) =>
      recorded.splitPane.push([deviceId, paneId, direction, cwd]),
    onWatchPane: (deviceId, paneId) => recorded.watch.push([deviceId, paneId]),
    ...overrides,
  };
  return { ctx, recorded };
}

function keysOf(ctx: SharedPaneActionContext): string[] {
  return buildSharedPaneActionItems(ctx).map((item) => item.key);
}

describe('buildSharedPaneActionItems', () => {
  const cases: Array<{
    name: string;
    overrides: Partial<SharedPaneActionContext>;
    expected: string[];
  }> = [
    {
      name: 'agent + cwd + watch',
      overrides: {},
      expected: ['new-session', 'new-in-cwd', 'split-right', 'split-down', 'watch'],
    },
    {
      name: 'no agent',
      overrides: { agent: undefined },
      expected: ['new-in-cwd', 'split-right', 'split-down', 'watch'],
    },
    {
      name: 'no cwd',
      overrides: { pane: makePane() },
      expected: ['new-session', 'split-right', 'split-down', 'watch'],
    },
    {
      name: 'watch ui disabled',
      overrides: { watchUi: false },
      expected: ['new-session', 'new-in-cwd', 'split-right', 'split-down'],
    },
    {
      name: 'no pane keeps only the agent session action',
      overrides: { pane: undefined },
      expected: ['new-session'],
    },
    {
      name: 'no pane and no agent yields nothing',
      overrides: { pane: undefined, agent: undefined },
      expected: [],
    },
  ];

  for (const { name, overrides, expected } of cases) {
    test(`${name} -> ${expected.join(',') || '(empty)'}`, () => {
      const { ctx } = makeContext(overrides);
      expect(keysOf(ctx)).toEqual(expected);
    });
  }

  test('maps test ids and labels per action', () => {
    const { ctx } = makeContext();
    const items = buildSharedPaneActionItems(ctx);
    expect(items.map((item) => [item.key, item.testId, item.label])).toEqual([
      ['new-session', 'ts-new-session', 'agent.session.new'],
      ['new-in-cwd', undefined, 'window.newInCwd'],
      ['split-right', 'ts-split-right', 'window.splitRight'],
      ['split-down', 'ts-split-down', 'window.splitDown'],
      ['watch', 'ts-watch', 'watch.openMonitor'],
    ]);
    expect(items.some((item) => item.destructive)).toBe(false);
  });

  test('session action targets sessionPane, not the cwd/split pane', () => {
    const { ctx, recorded } = makeContext({
      pane: makePane({ id: '%active', currentPath: '/srv' }),
      sessionPane: makePane({ id: '%selected' }),
    });
    const items = buildSharedPaneActionItems(ctx);
    items[0]?.onSelect();
    expect(recorded.session).toEqual([{ deviceId: 'dev-1', windowId: '@1', paneId: '%selected' }]);
  });

  test('cwd, split and watch actions use the target pane', () => {
    const { ctx, recorded } = makeContext({
      pane: makePane({ id: '%active', currentPath: '/srv' }),
    });
    const items = buildSharedPaneActionItems(ctx);
    for (const item of items.slice(1)) item.onSelect();
    expect(recorded.createWindow).toEqual([['dev-1', undefined, '/srv']]);
    expect(recorded.splitPane).toEqual([
      ['dev-1', '%active', 'right', '/srv'],
      ['dev-1', '%active', 'down', '/srv'],
    ]);
    expect(recorded.watch).toEqual([['dev-1', '%active']]);
  });

  test('split passes undefined cwd when the pane has no current path', () => {
    const { ctx, recorded } = makeContext({ pane: makePane({ id: '%bare' }) });
    for (const item of buildSharedPaneActionItems(ctx).slice(1)) item.onSelect();
    expect(recorded.splitPane).toEqual([
      ['dev-1', '%bare', 'right', undefined],
      ['dev-1', '%bare', 'down', undefined],
    ]);
    expect(recorded.createWindow).toEqual([]);
  });
});
