import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { type GatewayTransportCommand, createSharedGatewayTransport } from '@tmex/ws-client';
import { createAppRuntime } from './app-runtime';
import { installWindowStorage } from './test-utils';
import { selectPaneViewportOwner } from './viewport-policy';

installWindowStorage();

const initialSnapshot: StateSnapshotPayload = {
  deviceId: 'device-a',
  session: {
    id: '$1',
    name: 'main',
    windows: [
      {
        id: '@1',
        name: 'shell',
        index: 0,
        active: true,
        panes: [
          {
            id: '%1',
            windowId: '@1',
            index: 0,
            title: 'before',
            active: true,
            width: 80,
            height: 24,
          },
        ],
      },
    ],
  },
};

describe('tmux store shared transport adapter', () => {
  test('metadata stays incremental and does not subscribe terminal panes', () => {
    const commands: GatewayTransportCommand[] = [];
    const transport = createSharedGatewayTransport({
      initialState: 'READY',
      onCommand: (command) => {
        commands.push(command);
      },
    });
    const runtime = createAppRuntime({ transport, storagePrefix: 'shared-metadata:' });
    runtime.stores.tmux.getState().ensureSocketConnected();
    expect(runtime.stores.tmux.getState().stateFeedMode).toBe('canonical');
    commands.length = 0;

    transport.publish({ type: 'metadata-snapshot', snapshot: initialSnapshot });
    transport.publish({
      type: 'metadata-patch',
      deviceId: 'device-a',
      snapshot: wsBorsh.applyLegacyStateSnapshotDiff(initialSnapshot, {
        removals: [],
        upserts: [
          {
            entityKind: wsBorsh.SOURCE_ENTITY_PANE,
            nativeId: '%1',
            parentKind: wsBorsh.SOURCE_ENTITY_WINDOW,
            parentId: '@1',
            fields: [[wsBorsh.SOURCE_FIELD_TITLE, 'after']],
          },
        ],
      }),
    });

    const pane =
      runtime.stores.tmux.getState().snapshots['device-a']?.session?.windows[0]?.panes[0];
    expect(pane?.title).toBe('after');
    expect(commands.filter((command) => command.type === 'set-pane-subscriptions')).toEqual([]);

    runtime.dispose();
    transport.dispose();
  });

  test('mounted pane refcounts emit full subscription sets', () => {
    const commands: GatewayTransportCommand[] = [];
    const transport = createSharedGatewayTransport({
      initialState: 'READY',
      onCommand: (command) => {
        commands.push(command);
      },
    });
    const runtime = createAppRuntime({ transport, storagePrefix: 'shared-subscriptions:' });
    const tmux = runtime.stores.tmux.getState();
    tmux.ensureSocketConnected();
    commands.length = 0;

    const releaseFirst = tmux.mountPane('device-a', '%1');
    const releaseSecond = tmux.mountPane('device-a', '%1');
    const releaseOther = tmux.mountPane('device-a', '%2');
    releaseFirst();
    releaseSecond();
    releaseOther();

    const subscriptions = commands.filter(
      (command): command is Extract<GatewayTransportCommand, { type: 'set-pane-subscriptions' }> =>
        command.type === 'set-pane-subscriptions'
    );
    expect(subscriptions.map((command) => command.paneIds)).toEqual([
      ['%1'],
      ['%1'],
      ['%1', '%2'],
      ['%1', '%2'],
      ['%2'],
      [],
    ]);
    expect(subscriptions.map((command) => command.generation)).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);

    runtime.dispose();
    transport.dispose();
  });

  test('setPaneViewport emits a normalized terminal-viewport claim', () => {
    const commands: GatewayTransportCommand[] = [];
    const transport = createSharedGatewayTransport({
      initialState: 'READY',
      onCommand: (command) => {
        commands.push(command);
      },
    });
    const runtime = createAppRuntime({ transport, storagePrefix: 'shared-viewport:' });
    const tmux = runtime.stores.tmux.getState();
    tmux.ensureSocketConnected();
    commands.length = 0;

    tmux.setPaneViewport('device-a', '%1', { cols: 120.7, rows: 40, visible: true });
    tmux.setPaneViewport('device-a', '%1', { cols: 120, rows: 40, visible: false });
    tmux.setPaneViewport('', '%1', { cols: 120, rows: 40, visible: true });

    expect(commands.filter((command) => command.type === 'terminal-viewport')).toEqual([
      {
        type: 'terminal-viewport',
        deviceId: 'device-a',
        paneId: '%1',
        cols: 120,
        rows: 40,
        visible: true,
      },
      {
        type: 'terminal-viewport',
        deviceId: 'device-a',
        paneId: '%1',
        cols: 120,
        rows: 40,
        visible: false,
      },
    ]);

    runtime.dispose();
    transport.dispose();
  });

  test('terminal-viewport-policy lands in the store and clears on device disconnect', () => {
    const transport = createSharedGatewayTransport({ initialState: 'READY', onCommand: () => {} });
    const runtime = createAppRuntime({ transport, storagePrefix: 'shared-viewport-policy:' });
    runtime.stores.tmux.getState().ensureSocketConnected();

    transport.publish({
      type: 'terminal-viewport-policy',
      kind: 'terminal-viewport-policy',
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      owner: false,
      cols: 200,
      rows: 50,
    });
    expect(selectPaneViewportOwner(runtime.stores.tmux.getState(), 'device-a', '%1')).toBe(false);

    transport.publish({ type: 'device-disconnected', deviceId: 'device-a' });
    expect(selectPaneViewportOwner(runtime.stores.tmux.getState(), 'device-a', '%1')).toBe(true);

    runtime.dispose();
    transport.dispose();
  });
});
