import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { type GatewayTransportCommand, createSharedGatewayTransport } from '@tmex/ws-client';
import { createAppRuntime } from './app-runtime';
import { installWindowStorage } from './test-utils';

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
    commands.length = 0;

    transport.publish({ type: 'metadata-snapshot', snapshot: initialSnapshot });
    transport.publish({
      type: 'metadata-patch',
      deviceId: 'device-a',
      patch: {
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
      },
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
});
