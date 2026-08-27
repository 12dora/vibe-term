import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  GatewayTransportCommand,
  SelectCallbacks,
  SelectFailureReason,
} from '@tmex/ws-client';
import type { RuntimeCore } from './runtime';
import type { SiteStore } from './site';
import { createTmuxStore } from './tmux';
import type { UIStore } from './ui';

// selection 的 reselect 重试走全局 setTimeout；仅在本文件期间替换，afterEach 还原
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

function createHarness() {
  const commands: GatewayTransportCommand[] = [];
  let selectCallbacks: SelectCallbacks = {};

  const selectMachine = {
    dispatch: () => {},
    cleanup: () => {},
    getTransaction: () => null,
    reportTerminalProgress: () => {},
  };

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

  store.getState().connectDevice('device-a');
  store.getState().selectPane('device-a', '@1', '%1');
  commands.length = 0;

  return {
    store,
    disposers,
    commands,
    selectPaneCommands: () => commands.filter((command) => command.type === 'select-pane'),
    failSelect(reason: SelectFailureReason = 'ack_timeout'): void {
      selectCallbacks.onSelectFailed?.('device-a', reason);
    },
  };
}

describe('tmux store reselect retry', () => {
  let timers: ReturnType<typeof installFakeTimers>;

  beforeEach(() => {
    timers = installFakeTimers();
  });

  afterEach(() => {
    timers.restore();
  });

  test('non-rejected select failure retries the pending selection after 250ms', () => {
    const harness = createHarness();

    harness.failSelect();
    expect(timers.pending).toBe(1);

    timers.advance(250);

    expect(harness.selectPaneCommands()).toHaveLength(1);
    expect(harness.selectPaneCommands()[0]).toMatchObject({
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
    });
  });

  test('rejected select failure arms no retry', () => {
    const harness = createHarness();

    harness.failSelect('rejected');
    expect(timers.pending).toBe(0);

    timers.advance(250);

    expect(harness.selectPaneCommands()).toHaveLength(0);
  });

  test('disconnectDevice cancels the armed reselect retry', () => {
    const harness = createHarness();

    harness.failSelect();
    expect(timers.pending).toBe(1);

    harness.store.getState().disconnectDevice('device-a');
    expect(timers.pending).toBe(0);

    timers.advance(250);

    expect(harness.selectPaneCommands()).toHaveLength(0);
    expect(harness.commands.map((command) => command.type)).toEqual(['disconnect-device']);
  });

  test('disconnectDevice 立即落地断开态，不等网关事件', () => {
    const harness = createHarness();

    harness.store.setState((prev) => ({
      deviceConnected: { ...prev.deviceConnected, 'device-a': true },
      deviceReconnecting: {
        ...prev.deviceReconnecting,
        'device-a': { message: 'reconnecting', at: Date.now() },
      },
    }));

    harness.store.getState().disconnectDevice('device-a');

    const state = harness.store.getState();
    expect(state.connectedDevices.has('device-a')).toBe(false);
    expect(state.deviceConnected['device-a']).toBe(false);
    expect(state.deviceReconnecting['device-a']).toBeUndefined();
  });

  test('connect → disconnect → 立即 connect 会再次下发 connect-device', () => {
    const harness = createHarness();

    harness.store.getState().connectDevice('device-b');
    harness.store.getState().disconnectDevice('device-b');
    harness.store.getState().connectDevice('device-b');

    expect(harness.commands.map((command) => command.type)).toEqual([
      'connect-device',
      'disconnect-device',
      'connect-device',
    ]);
  });
});
