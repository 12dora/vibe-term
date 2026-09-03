// 设备连接/断开动作的即时状态与去重下发（原 tmux-reselect-retry.test.ts；
// legacy 选择事务下线后，reselect 重试一并消失，只留这两条设备面行为）。

import { describe, expect, test } from 'bun:test';
import type { GatewayTransportCommand } from '@tmex/ws-client';
import type { RuntimeCore } from './runtime';
import type { SiteStore } from './site';
import { createTmuxStore } from './tmux';
import type { UIStore } from './ui';

function createHarness() {
  const commands: GatewayTransportCommand[] = [];

  const core = {
    transport: {
      capabilities: { atomicScreen: true, cursorHistory: true },
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
    paneSinks: {
      dispatchPaneTerminalData: () => {},
      cleanupDevicePaneState: () => {},
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

  return { store, disposers, commands };
}

describe('tmux store device connect actions', () => {
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
    expect(harness.commands.map((command) => command.type)).toEqual(['disconnect-device']);
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
