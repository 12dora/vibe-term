import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import { switchBarrier } from './borsh/switch-barrier';
import { WebSocketServer } from './index';
import { createBorshTestWs, setupConnectionEntry } from './test-helpers';
import type { ClientState, DeviceConnectionEntry } from './types';

const DEVICE_ID = 'device-a';

type PrivateFeedAccess = {
  feed: { legacyPaneObserverCount(deviceId: string, paneId: string): number };
  registry: {
    finalizeReconnectFailure(
      deviceId: string,
      entry: DeviceConnectionEntry,
      event: { deviceId: string; type: string }
    ): void;
  };
};

const servers: WebSocketServer[] = [];
const sockets: Array<ServerWebSocket<ClientState>> = [];
const pushSpies: Array<ReturnType<typeof spyOn>> = [];

afterEach(() => {
  for (const spy of pushSpies) spy.mockRestore();
  pushSpies.length = 0;
  for (const ws of sockets) {
    switchBarrier.cleanupClient(ws);
  }
  sockets.length = 0;
  for (const server of servers) {
    server.terminalOutputBatcher.discardDevice(DEVICE_ID);
  }
  servers.length = 0;
});

function makeSnapshot(): StateSnapshotPayload {
  return {
    deviceId: DEVICE_ID,
    session: {
      id: '$1',
      name: 'tmex',
      windows: [
        {
          id: '@1',
          name: 'one',
          index: 0,
          active: true,
          panes: [
            {
              id: '%1',
              windowId: '@1',
              index: 0,
              title: 'one-pane',
              active: true,
              width: 80,
              height: 24,
            },
          ],
        },
        {
          id: '@2',
          name: 'two',
          index: 1,
          active: false,
          panes: [
            {
              id: '%2',
              windowId: '@2',
              index: 0,
              title: 'two-pane',
              active: true,
              width: 80,
              height: 24,
            },
          ],
        },
      ],
    },
  };
}

function createServer(): WebSocketServer {
  const server = new WebSocketServer();
  servers.push(server);
  return server;
}

function createWs() {
  const ws = createBorshTestWs({ session: true });
  sockets.push(ws);
  return ws;
}

function setupClients(server: WebSocketServer, clients: Array<ReturnType<typeof createWs>>) {
  return setupConnectionEntry(server, {
    deviceId: DEVICE_ID,
    ws: clients[0],
    clients: new Set(clients),
    runtime: {
      requestSnapshot() {},
      selectPane() {},
      selectPaneWithSize() {},
      focusPane() {},
    },
    lastSnapshot: makeSnapshot(),
  });
}

function observerCount(server: WebSocketServer, paneId: string): number {
  return (server as unknown as PrivateFeedAccess).feed.legacyPaneObserverCount(DEVICE_ID, paneId);
}

function finalizeReconnect(server: WebSocketServer, entry: DeviceConnectionEntry): void {
  (server as unknown as PrivateFeedAccess).registry.finalizeReconnectFailure(DEVICE_ID, entry, {
    deviceId: DEVICE_ID,
    type: 'disconnected',
  });
}

function spyPush(server: WebSocketServer) {
  const spy = spyOn(server.terminalOutputBatcher, 'push');
  pushSpies.push(spy);
  return spy;
}

function selectPane(
  server: WebSocketServer,
  ws: ServerWebSocket<ClientState>,
  paneId: string,
  windowId: string
): void {
  server.handleTmuxSelect(ws, {
    deviceId: DEVICE_ID,
    windowId,
    paneId,
    selectToken: new Uint8Array(16).fill(1),
    wantHistory: true,
    cols: null,
    rows: null,
  });
}

describe('legacy observer wiring', () => {
  test('select records one observer and batches terminal output', () => {
    const server = createServer();
    const ws = createWs();
    setupClients(server, [ws]);
    const push = spyPush(server);

    selectPane(server, ws, '%1', '@1');

    expect(observerCount(server, '%1')).toBe(1);
    server.broadcastTerminalOutput(DEVICE_ID, '%1', new Uint8Array([1]));
    expect(push).toHaveBeenCalledTimes(1);
  });

  test('focus pane records one observer and batches terminal output', () => {
    const server = createServer();
    const ws = createWs();
    setupClients(server, [ws]);
    const push = spyPush(server);

    server.handleFocusPane(ws, DEVICE_ID, '@1', '%1');

    expect(observerCount(server, '%1')).toBe(1);
    server.broadcastTerminalOutput(DEVICE_ID, '%1', new Uint8Array([2]));
    expect(push).toHaveBeenCalledTimes(1);
  });

  test('unsubscribe drops the count and skips batching', () => {
    const server = createServer();
    const ws = createWs();
    setupClients(server, [ws]);
    const push = spyPush(server);

    server.handleSubscribePanes(ws, DEVICE_ID, ['%1']);
    expect(observerCount(server, '%1')).toBe(1);
    server.broadcastTerminalOutput(DEVICE_ID, '%1', new Uint8Array([3]));
    expect(push).toHaveBeenCalledTimes(1);

    server.handleSubscribePanes(ws, DEVICE_ID, []);
    expect(observerCount(server, '%1')).toBe(0);
    server.broadcastTerminalOutput(DEVICE_ID, '%1', new Uint8Array([4]));
    expect(push).toHaveBeenCalledTimes(1);
  });

  test('selecting a different pane drops the previous observer and skips batching', () => {
    const server = createServer();
    const ws = createWs();
    setupClients(server, [ws]);
    const push = spyPush(server);

    selectPane(server, ws, '%1', '@1');
    expect(observerCount(server, '%1')).toBe(1);

    selectPane(server, ws, '%2', '@2');
    expect(observerCount(server, '%1')).toBe(0);
    expect(observerCount(server, '%2')).toBe(1);

    server.broadcastTerminalOutput(DEVICE_ID, '%1', new Uint8Array([5]));
    expect(push).not.toHaveBeenCalled();
    server.broadcastTerminalOutput(DEVICE_ID, '%2', new Uint8Array([6]));
    expect(push).toHaveBeenCalledTimes(1);
  });

  test('closing the socket releases observers to zero', () => {
    const server = createServer();
    const ws = createWs();
    setupClients(server, [ws]);
    const push = spyPush(server);

    selectPane(server, ws, '%1', '@1');
    expect(observerCount(server, '%1')).toBe(1);

    server.handleClose(ws);
    expect(observerCount(server, '%1')).toBe(0);
    server.broadcastTerminalOutput(DEVICE_ID, '%1', new Uint8Array([7]));
    expect(push).not.toHaveBeenCalled();
  });

  test('device disconnect releases observers to zero', () => {
    const server = createServer();
    const ws = createWs();
    setupClients(server, [ws]);
    const push = spyPush(server);

    selectPane(server, ws, '%1', '@1');
    expect(observerCount(server, '%1')).toBe(1);

    server.handleDeviceDisconnect(ws, DEVICE_ID);
    expect(observerCount(server, '%1')).toBe(0);
    server.broadcastTerminalOutput(DEVICE_ID, '%1', new Uint8Array([8]));
    expect(push).not.toHaveBeenCalled();
  });

  test('two clients selecting the same pane share the count; closing one leaves one', () => {
    const server = createServer();
    const ws1 = createWs();
    const ws2 = createWs();
    setupClients(server, [ws1, ws2]);

    selectPane(server, ws1, '%1', '@1');
    selectPane(server, ws2, '%1', '@1');
    expect(observerCount(server, '%1')).toBe(2);

    server.handleClose(ws1);
    expect(observerCount(server, '%1')).toBe(1);

    const push = spyPush(server);
    server.broadcastTerminalOutput(DEVICE_ID, '%1', new Uint8Array([9]));
    expect(push).toHaveBeenCalledTimes(1);
  });

  test('finalizeReconnectFailure releases observers for remaining clients', () => {
    const server = createServer();
    const ws = createWs();
    const entry = setupClients(server, [ws]);
    const push = spyPush(server);

    selectPane(server, ws, '%1', '@1');
    expect(observerCount(server, '%1')).toBe(1);

    finalizeReconnect(server, entry);
    expect(observerCount(server, '%1')).toBe(0);
    server.broadcastTerminalOutput(DEVICE_ID, '%1', new Uint8Array([10]));
    expect(push).not.toHaveBeenCalled();
  });

  test('manual reconnect after finalizeReconnectFailure re-syncs observers and delivers output', async () => {
    const server = new WebSocketServer({
      deps: {
        acquireRuntime: async () =>
          ({
            async connect() {},
            subscribe() {
              return () => {};
            },
            requestSnapshot() {},
            disconnect() {},
            getCurrentSnapshot() {
              return makeSnapshot();
            },
          }) as never,
      },
    });
    servers.push(server);
    const ws = createWs();
    const entry = setupClients(server, [ws]);
    const push = spyPush(server);

    server.handleSubscribePanes(ws, DEVICE_ID, ['%1']);
    expect(observerCount(server, '%1')).toBe(1);
    expect(ws.data.borshState.subscribedPanes[DEVICE_ID]?.has('%1')).toBe(true);

    server.broadcastTerminalOutput(DEVICE_ID, '%1', new Uint8Array([11]));
    expect(push).toHaveBeenCalledTimes(1);

    finalizeReconnect(server, entry);
    expect(observerCount(server, '%1')).toBe(0);
    expect(ws.data.borshState.subscribedPanes[DEVICE_ID]?.has('%1')).toBe(true);
    server.broadcastTerminalOutput(DEVICE_ID, '%1', new Uint8Array([12]));
    expect(push).toHaveBeenCalledTimes(1);

    await server.handleDeviceConnect(ws, DEVICE_ID);
    expect(observerCount(server, '%1')).toBe(1);
    server.broadcastTerminalOutput(DEVICE_ID, '%1', new Uint8Array([13]));
    expect(push).toHaveBeenCalledTimes(2);

    server.handleDeviceDisconnect(ws, DEVICE_ID);
  });
});
