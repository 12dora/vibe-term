import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload, TmuxPane, TmuxWindow } from '@tmex/shared';
import type { GatewayTransportCommand } from '@tmex/ws-client';
import type { RuntimeCore } from './runtime';
import type { SiteStore } from './site';
import { createTmuxStore } from './tmux';
import type { UIStore } from './ui';

const DEVICE = 'device-a';

function makePane(windowId: string, index: number): TmuxPane {
  return {
    id: `%${index}`,
    windowId,
    index,
    active: index === 0,
    width: 80,
    height: 24,
  };
}

function makeWindow(index: number, paneCount: number): TmuxWindow {
  const id = `@${index}`;
  return {
    id,
    name: `w${index}`,
    index,
    active: index === 0,
    panes: Array.from({ length: paneCount }, (_, i) => makePane(id, i)),
  };
}

function makeSnapshot(windowCount: number, paneCount: number): StateSnapshotPayload {
  return {
    deviceId: DEVICE,
    session: {
      id: '$0',
      name: 'main',
      windows: Array.from({ length: windowCount }, (_, i) => makeWindow(i, paneCount)),
    },
  };
}

function createHarness(snapshot: StateSnapshotPayload) {
  const commands: GatewayTransportCommand[] = [];

  const core = {
    transport: {
      capabilities: { atomicScreen: false, cursorHistory: false },
      send: (command: GatewayTransportCommand) => {
        commands.push(command);
        return true;
      },
      onEvent: () => () => {},
      getState: () => 'IDLE',
      isReady: () => false,
      connect: () => {},
      hasConnectedOnce: false,
      latencyMs: null,
    },
    selectMachine: () => ({
      dispatch: () => {},
      cleanup: () => {},
      getTransaction: () => null,
      reportTerminalProgress: () => {},
    }),
    paneSinks: {
      dispatchPaneReset: () => {},
      dispatchPaneApplyHistory: () => {},
      dispatchPaneOutput: () => {},
      cleanupDevicePaneState: () => {},
      beginPaneHistoryGate: () => {},
    },
    notifications: { info: () => {}, success: () => {}, warning: () => {}, error: () => {} },
    bell: { play: () => {} },
    t: (key: string) => key,
    host: { navigate: () => {} },
    features: { hostManagedNotifications: false },
  } as unknown as RuntimeCore;

  const ui = {
    getState: () => ({ theme: 'dark' }),
    subscribe: () => () => {},
  } as unknown as UIStore;
  const site = { getState: () => ({ settings: undefined }) } as unknown as SiteStore;

  const store = createTmuxStore(core, { getUI: () => ui, getSite: () => site }, []);
  store.setState({ snapshots: { [DEVICE]: snapshot } });
  commands.length = 0;

  return {
    store,
    commands,
    windowIds(): string[] {
      return (store.getState().snapshots[DEVICE]?.session?.windows ?? []).map((w) => w.id);
    },
    paneIds(windowId: string): string[] {
      const windows = store.getState().snapshots[DEVICE]?.session?.windows ?? [];
      return (windows.find((w) => w.id === windowId)?.panes ?? []).map((p) => p.id);
    },
  };
}

describe('tmux store reorderWindows', () => {
  test('reorders 200 windows: requested prefix first, rest keeps original order', () => {
    const harness = createHarness(makeSnapshot(200, 1));
    const requested = Array.from({ length: 100 }, (_, i) => `@${99 - i}`);

    harness.store.getState().reorderWindows(DEVICE, requested);

    const expectedRest = Array.from({ length: 100 }, (_, i) => `@${100 + i}`);
    expect(harness.windowIds()).toEqual([...requested, ...expectedRest]);
    expect(harness.commands).toEqual([
      { type: 'reorder-windows', deviceId: DEVICE, windowIds: requested },
    ]);
  });

  test('full reorder of 200 windows keeps exactly the requested order', () => {
    const harness = createHarness(makeSnapshot(200, 1));
    const requested = Array.from({ length: 200 }, (_, i) => `@${199 - i}`);

    harness.store.getState().reorderWindows(DEVICE, requested);

    expect(harness.windowIds()).toEqual(requested);
  });

  test('unknown ids are dropped and never shadow existing windows', () => {
    const harness = createHarness(makeSnapshot(4, 1));

    harness.store.getState().reorderWindows(DEVICE, ['@3', '@ghost', '@1']);

    expect(harness.windowIds()).toEqual(['@3', '@1', '@0', '@2']);
  });

  test('empty id list is a no-op', () => {
    const harness = createHarness(makeSnapshot(3, 1));

    harness.store.getState().reorderWindows(DEVICE, []);

    expect(harness.windowIds()).toEqual(['@0', '@1', '@2']);
    expect(harness.commands).toEqual([]);
  });
});

describe('tmux store reorderPanes', () => {
  test('reorders 200 panes inside the target window only', () => {
    const harness = createHarness(makeSnapshot(2, 200));
    const requested = Array.from({ length: 100 }, (_, i) => `%${99 - i}`);

    harness.store.getState().reorderPanes(DEVICE, '@0', requested);

    const expectedRest = Array.from({ length: 100 }, (_, i) => `%${100 + i}`);
    expect(harness.paneIds('@0')).toEqual([...requested, ...expectedRest]);
    expect(harness.paneIds('@1')).toEqual(Array.from({ length: 200 }, (_, i) => `%${i}`));
    expect(harness.commands).toEqual([
      { type: 'reorder-panes', deviceId: DEVICE, windowId: '@0', paneIds: requested },
    ]);
  });

  test('unknown pane ids are dropped', () => {
    const harness = createHarness(makeSnapshot(1, 4));

    harness.store.getState().reorderPanes(DEVICE, '@0', ['%2', '%ghost', '%0']);

    expect(harness.paneIds('@0')).toEqual(['%2', '%0', '%1', '%3']);
  });

  test('unknown window id leaves the snapshot untouched', () => {
    const harness = createHarness(makeSnapshot(1, 3));

    harness.store.getState().reorderPanes(DEVICE, '@missing', ['%2', '%0']);

    expect(harness.paneIds('@0')).toEqual(['%0', '%1', '%2']);
  });
});
