// 快照删除当前选中 pane 时的选择面收尾：取消事务/重试 + 清空 selectedPanes。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload, TmuxPane, TmuxWindow } from '@tmex/shared';
import type {
  GatewayTransportCommand,
  GatewayTransportEvent,
  SelectCallbacks,
} from '@tmex/ws-client';
import type { RuntimeCore } from './runtime';
import type { SiteStore } from './site';
import { createTmuxStore } from './tmux';
import type { UIStore } from './ui';

function installFakeTimers() {
  const timers = new Map<number, { fn: () => void; delay: number }>();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let nextId = 1;

  globalThis.setTimeout = ((fn: () => void, delay?: number) => {
    const id = nextId++;
    timers.set(id, { fn, delay: delay ?? 0 });
    return id;
  }) as unknown as typeof setTimeout;

  globalThis.clearTimeout = ((id?: number) => {
    if (id !== undefined) timers.delete(id);
  }) as unknown as typeof clearTimeout;

  return {
    advance(ms: number): void {
      for (const [id, timer] of [...timers]) {
        if (timer.delay > ms) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    get pending(): number {
      return timers.size;
    },
    restore(): void {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

function pane(id: string): TmuxPane {
  return { id, windowId: '@1', index: 0, active: true, width: 80, height: 24 };
}

function snapshotWith(panes: TmuxPane[]): StateSnapshotPayload {
  const window: TmuxWindow = { id: '@1', name: 'shell', index: 0, active: true, panes };
  return { deviceId: 'device-a', session: { id: '$1', name: 'main', windows: [window] } };
}

function createHarness() {
  const commands: GatewayTransportCommand[] = [];
  const abandoned: Array<[string, string]> = [];
  let emit: ((event: GatewayTransportEvent) => void) | null = null;
  let selectCallbacks: SelectCallbacks = {};

  const selectMachine = {
    dispatch: () => {},
    cleanup: () => {},
    getTransaction: () => null,
    reportTerminalProgress: () => {},
    abandonPane: (deviceId: string, paneId: string) => {
      abandoned.push([deviceId, paneId]);
      return true;
    },
  };

  const core = {
    transport: {
      capabilities: { atomicScreen: false, cursorHistory: false },
      send: (command: GatewayTransportCommand) => {
        commands.push(command);
        return true;
      },
      onEvent: (handler: (event: GatewayTransportEvent) => void) => {
        emit = handler;
        return () => {
          emit = null;
        };
      },
      getState: () => 'IDLE',
      isReady: () => false,
      connect: () => {},
      hasConnectedOnce: false,
      latencyMs: null,
    },
    selectMachine: (callbacks?: SelectCallbacks) => {
      if (callbacks) selectCallbacks = callbacks;
      return selectMachine;
    },
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

  const disposers: Array<() => void> = [];
  const store = createTmuxStore(core, { getUI: () => ui, getSite: () => site }, disposers);
  store.getState().ensureSocketConnected();

  return {
    store,
    commands,
    abandoned,
    publish(event: GatewayTransportEvent): void {
      emit?.(event);
    },
    failSelect(): void {
      selectCallbacks.onSelectFailed?.('device-a', 'ack_timeout');
    },
    dispose(): void {
      for (const dispose of disposers) dispose();
    },
  };
}

describe('snapshot removal of the selected pane', () => {
  let timers: ReturnType<typeof installFakeTimers>;

  beforeEach(() => {
    timers = installFakeTimers();
  });

  afterEach(() => {
    timers.restore();
  });

  test('clears the selection and cancels the transaction once the pane leaves the snapshot', () => {
    const harness = createHarness();
    harness.publish({ type: 'metadata-snapshot', snapshot: snapshotWith([pane('%1'), pane('%2')]) });
    harness.store.getState().selectPane('device-a', '@1', '%2');

    harness.publish({ type: 'metadata-snapshot', snapshot: snapshotWith([pane('%1')]) });

    expect(harness.store.getState().selectedPanes['device-a']).toBeUndefined();
    expect(harness.abandoned).toEqual([['device-a', '%2']]);
    harness.dispose();
  });

  test('keeps a selection whose pane was never in a snapshot yet', () => {
    const harness = createHarness();
    harness.publish({ type: 'metadata-snapshot', snapshot: snapshotWith([pane('%1')]) });
    // 刚 split 出来的 pane：快照还没追上，不能当成已关闭
    harness.store.getState().selectPane('device-a', '@1', '%9');

    harness.publish({ type: 'metadata-snapshot', snapshot: snapshotWith([pane('%1')]) });

    expect(harness.store.getState().selectedPanes['device-a']).toEqual({
      windowId: '@1',
      paneId: '%9',
    });
    expect(harness.abandoned).toEqual([]);
    harness.dispose();
  });

  test('keeps a selection whose pane only moved to another window', () => {
    const harness = createHarness();
    harness.publish({ type: 'metadata-snapshot', snapshot: snapshotWith([pane('%1'), pane('%2')]) });
    harness.store.getState().selectPane('device-a', '@1', '%2');

    harness.publish({
      type: 'metadata-snapshot',
      snapshot: {
        deviceId: 'device-a',
        session: {
          id: '$1',
          name: 'main',
          windows: [
            { id: '@1', name: 'shell', index: 0, active: false, panes: [pane('%1')] },
            { id: '@2', name: 'moved', index: 1, active: true, panes: [pane('%2')] },
          ],
        },
      },
    });

    expect(harness.store.getState().selectedPanes['device-a']).toEqual({
      windowId: '@1',
      paneId: '%2',
    });
    expect(harness.abandoned).toEqual([]);
    harness.dispose();
  });

  test('cancels the pending reselect retry so no select-pane targets the dead pane', () => {
    const harness = createHarness();
    harness.publish({ type: 'metadata-snapshot', snapshot: snapshotWith([pane('%1'), pane('%2')]) });
    harness.store.getState().selectPane('device-a', '@1', '%2');

    // select 失败排队一次 250ms 重试，随后快照确认 pane 已消失
    harness.failSelect();
    expect(timers.pending).toBe(1);
    harness.commands.length = 0;

    harness.publish({ type: 'metadata-snapshot', snapshot: snapshotWith([pane('%1')]) });
    expect(timers.pending).toBe(0);
    timers.advance(1000);

    expect(harness.commands.filter((command) => command.type === 'select-pane')).toEqual([]);
    expect(harness.store.getState().selectedPanes['device-a']).toBeUndefined();
    harness.dispose();
  });
});
