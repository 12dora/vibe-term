// 快照删除当前选中 pane 时的选择面收尾：清空 selectedPanes。

import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload, TmuxPane, TmuxWindow } from '@tmex/shared';
import type { GatewayTransportCommand, GatewayTransportEvent } from '@tmex/ws-client';
import type { RuntimeCore } from './runtime';
import type { SiteStore } from './site';
import { createTmuxStore } from './tmux';
import type { UIStore } from './ui';

function pane(id: string): TmuxPane {
  return { id, windowId: '@1', index: 0, active: true, width: 80, height: 24 };
}

function snapshotWith(panes: TmuxPane[]): StateSnapshotPayload {
  const window: TmuxWindow = { id: '@1', name: 'shell', index: 0, active: true, panes };
  return { deviceId: 'device-a', session: { id: '$1', name: 'main', windows: [window] } };
}

function createHarness() {
  const commands: GatewayTransportCommand[] = [];
  let emit: ((event: GatewayTransportEvent) => void) | null = null;

  const core = {
    transport: {
      capabilities: { atomicScreen: true, cursorHistory: true },
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
  store.getState().ensureSocketConnected();

  return {
    store,
    commands,
    publish(event: GatewayTransportEvent): void {
      emit?.(event);
    },
    dispose(): void {
      for (const dispose of disposers) dispose();
    },
  };
}

describe('snapshot removal of the selected pane', () => {
  test('clears the selection once the pane leaves the snapshot', () => {
    const harness = createHarness();
    harness.publish({
      type: 'metadata-snapshot',
      snapshot: snapshotWith([pane('%1'), pane('%2')]),
    });
    harness.store.getState().selectPane('device-a', '@1', '%2');

    harness.publish({ type: 'metadata-snapshot', snapshot: snapshotWith([pane('%1')]) });

    expect(harness.store.getState().selectedPanes['device-a']).toBeUndefined();
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
    harness.dispose();
  });

  test('keeps a selection whose pane only moved to another window', () => {
    const harness = createHarness();
    harness.publish({
      type: 'metadata-snapshot',
      snapshot: snapshotWith([pane('%1'), pane('%2')]),
    });
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
    harness.dispose();
  });
});
