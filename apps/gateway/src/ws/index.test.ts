import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { ensureSiteSettingsInitialized, getSiteSettings, updateSiteSettings } from '../db';
import { runMigrations } from '../db/migrate';
import { createBorshClientState } from './borsh/codec-borsh';
import { sessionStateStore } from './borsh/session-state';
import { switchBarrier } from './borsh/switch-barrier';
import { SNAPSHOT_WATCHDOG_INTERVAL_MS, WebSocketServer } from './index';

// 快照下发路径会同步读 device_tree_order 表，确保所有用例前已建表
beforeAll(() => {
  runMigrations();
});

function createMockWs() {
  return {
    data: { selectedPanes: {} as Record<string, string | null> },
    sent: [] as string[],
    send(message: string) {
      this.sent.push(message);
    },
  };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('WebSocketServer connection entry dedup', () => {
  test('deduplicates concurrent creation for same device', async () => {
    const server = new WebSocketServer() as any;
    const ws = createMockWs() as any;
    let acquireCalls = 0;

    const releaseRef: { current: (() => void) | null } = { current: null };
    const gate = new Promise<void>((resolve) => {
      releaseRef.current = resolve;
    });

    server.deps.acquireRuntime = async () => {
      acquireCalls += 1;
      await gate;
      return {
        async connect() {},
        subscribe() {
          return () => {};
        },
        requestSnapshot() {},
        disconnect() {},
      };
    };

    const p1 = server.getOrCreateConnectionEntry('device-a', ws);
    const p2 = server.getOrCreateConnectionEntry('device-a', ws);
    const p3 = server.getOrCreateConnectionEntry('device-a', ws);

    if (releaseRef.current) {
      releaseRef.current();
    }
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(acquireCalls).toBe(1);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(server.pendingConnectionEntries.size).toBe(0);
    expect(server.connections.get('device-a')).toBe(r1);
  });

  test('clears pending state on failure and allows retry', async () => {
    const server = new WebSocketServer() as any;
    const ws = createMockWs() as any;
    let acquireCalls = 0;

    const fakeEntry = {
      runtime: {},
      detachRuntime: () => {},
      clients: new Set(),
      lastSnapshot: null,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    };

    server.createDeviceConnectionEntry = async () => {
      acquireCalls += 1;
      if (acquireCalls === 1) {
        return null;
      }
      return fakeEntry;
    };

    const first = await server.getOrCreateConnectionEntry('device-b', ws);
    expect(first).toBeNull();
    expect(server.pendingConnectionEntries.size).toBe(0);

    const second = await server.getOrCreateConnectionEntry('device-b', ws);
    expect(second).toBe(fakeEntry);
    expect(acquireCalls).toBe(2);
    expect(server.pendingConnectionEntries.size).toBe(0);
    expect(server.connections.get('device-b')).toBe(fakeEntry);
  });

  test('releases runtime when last websocket client disconnects from device', async () => {
    const released: string[] = [];
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
          }) as any,
        releaseRuntime: async (deviceId) => {
          released.push(deviceId);
        },
      },
    }) as any;

    const ws = {
      data: { borshState: createBorshClientState() },
      send() {},
    } as any;

    sessionStateStore.create(ws);

    const entry = await server.getOrCreateConnectionEntry('device-c', ws);
    entry.clients.add(ws);
    ws.data.borshState.selectedPanes['device-c'] = '%1';

    server.handleDeviceDisconnect(ws, 'device-c');

    expect(released).toEqual(['device-c']);
  });

  test('reuses the same runtime when a second websocket client connects to the same device', async () => {
    let acquireCalls = 0;
    let connectCalls = 0;
    const server = new WebSocketServer({
      deps: {
        acquireRuntime: async () => {
          acquireCalls += 1;
          return {
            async connect() {
              connectCalls += 1;
            },
            subscribe() {
              return () => {};
            },
            requestSnapshot() {},
            disconnect() {},
          } as any;
        },
      },
    }) as any;

    const ws1 = {
      data: { borshState: createBorshClientState() },
      sent: [] as Uint8Array[],
      send(message: Uint8Array) {
        this.sent.push(message);
      },
    } as any;
    const ws2 = {
      data: { borshState: createBorshClientState() },
      sent: [] as Uint8Array[],
      send(message: Uint8Array) {
        this.sent.push(message);
      },
    } as any;

    sessionStateStore.create(ws1);
    sessionStateStore.create(ws2);

    await server.handleDeviceConnect(ws1, 'device-shared');
    await server.handleDeviceConnect(ws2, 'device-shared');

    expect(acquireCalls).toBe(1);
    expect(connectCalls).toBe(1);
    expect(server.connections.get('device-shared')?.clients.size).toBe(2);
  });
});

describe('WebSocketServer snapshot recovery watchdog', () => {
  test('keeps the default idle refresh budget at no more than six full snapshots per minute', () => {
    expect(Math.ceil(60_000 / SNAPSHOT_WATCHDOG_INTERVAL_MS)).toBeLessThanOrEqual(6);
  });

  test('starts the recovery watchdog only while a client has an active pane subscription', () => {
    const server = new WebSocketServer() as any;
    const ws = {
      data: { borshState: createBorshClientState() },
      send() {},
    } as any;
    sessionStateStore.create(ws);

    const entry = {
      runtime: { requestSnapshot() {} },
      detachRuntime: () => {},
      clients: new Set([ws]),
      lastSnapshot: null,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    };
    server.connections.set('device-watchdog', entry);

    const setIntervalSpy = spyOn(globalThis, 'setInterval');
    try {
      server.refreshSnapshotPolling('device-watchdog');
      expect(setIntervalSpy).not.toHaveBeenCalled();

      ws.data.borshState.selectedPanes['device-watchdog'] = '%1';
      server.refreshSnapshotPolling('device-watchdog');
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(SNAPSHOT_WATCHDOG_INTERVAL_MS);

      ws.data.borshState.selectedPanes['device-watchdog'] = undefined;
      server.refreshSnapshotPolling('device-watchdog');
      expect(entry.snapshotPollTimer).toBeNull();
    } finally {
      if (entry.snapshotPollTimer) {
        clearInterval(entry.snapshotPollTimer);
      }
      setIntervalSpy.mockRestore();
    }
  });
});

describe('WebSocketServer slow consumer isolation', () => {
  test('coalesces pending pane output before encoding it for clients', () => {
    const server = new WebSocketServer() as any;
    const frames: Uint8Array[] = [];
    const ws = {
      data: { borshState: createBorshClientState() },
      send(frame: Uint8Array) {
        frames.push(frame);
        return frame.length;
      },
      terminate() {},
    } as any;
    ws.data.borshState.selectedPanes['device-batch'] = '%1';
    server.connections.set('device-batch', {
      clients: new Set([ws]),
      lastSnapshot: null,
    });

    server.broadcastTerminalOutput('device-batch', '%1', new Uint8Array([1, 2]));
    server.broadcastTerminalOutput('device-batch', '%1', new Uint8Array([3]));

    expect(frames).toHaveLength(0);
    server.terminalOutputBatcher.flushDevice('device-batch');
    expect(frames).toHaveLength(1);

    const envelope = wsBorsh.decodeEnvelope(frames[0] as Uint8Array);
    const payload = wsBorsh.decodePayload(wsBorsh.schema.TermOutputSchema, envelope.payload);
    expect(Array.from(payload.data)).toEqual([1, 2, 3]);
  });

  test('stops encoding live output while blocked and terminates after a skipped frame drains', () => {
    const server = new WebSocketServer() as any;
    let sendCalls = 0;
    let terminateCalls = 0;
    const ws = {
      data: { borshState: createBorshClientState() },
      send() {
        sendCalls += 1;
        return -1;
      },
      terminate() {
        terminateCalls += 1;
      },
    } as any;
    ws.data.borshState.selectedPanes['device-slow'] = '%1';
    server.connections.set('device-slow', {
      clients: new Set([ws]),
      lastSnapshot: null,
    });

    server.broadcastTerminalOutput('device-slow', '%1', new Uint8Array([1]));
    server.terminalOutputBatcher.flushDevice('device-slow');
    server.broadcastTerminalOutput('device-slow', '%1', new Uint8Array([2]));
    server.terminalOutputBatcher.flushDevice('device-slow');

    expect(sendCalls).toBe(1);
    expect(terminateCalls).toBe(0);

    server.handleDrain(ws);

    expect(terminateCalls).toBe(1);
  });
});

describe('WebSocketServer tmux select guards', () => {
  function makeSnapshot(): StateSnapshotPayload {
    return {
      deviceId: 'device-a',
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

  function createBorshWs() {
    const ws = {
      data: { borshState: createBorshClientState() },
      sent: [] as Uint8Array[],
      send(message: Uint8Array) {
        this.sent.push(message);
      },
    } as any;
    sessionStateStore.create(ws);
    return ws;
  }

  function createRuntimeRecorder() {
    const recorder = {
      requestSnapshotCalls: 0,
      selectWindowCalls: [] as string[],
      selectPaneCalls: [] as Array<{
        windowId: string;
        paneId: string;
        size?: { cols: number; rows: number };
      }>,
      runtime: {
        requestSnapshot() {
          recorder.requestSnapshotCalls += 1;
        },
        selectWindow(windowId: string) {
          recorder.selectWindowCalls.push(windowId);
        },
        selectPane(windowId: string, paneId: string) {
          recorder.selectPaneCalls.push({ windowId, paneId });
        },
        selectPaneWithSize(windowId: string, paneId: string, cols: number, rows: number) {
          recorder.selectPaneCalls.push({ windowId, paneId, size: { cols, rows } });
        },
      },
    };
    return recorder;
  }

  function setupEntry(
    server: any,
    ws: any,
    runtime: ReturnType<typeof createRuntimeRecorder>['runtime'],
    snapshot: StateSnapshotPayload | null = makeSnapshot()
  ) {
    const entry = {
      runtime,
      detachRuntime: () => {},
      clients: new Set([ws]),
      lastSnapshot: snapshot,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    };
    server.connections.set('device-a', entry);
    return entry;
  }

  function clearPolling(entry: { snapshotPollTimer: ReturnType<typeof setInterval> | null }) {
    if (entry.snapshotPollTimer) {
      clearInterval(entry.snapshotPollTimer);
      entry.snapshotPollTimer = null;
    }
  }

  test('rejects invalid select-window ids before calling runtime', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    const recorder = createRuntimeRecorder();
    setupEntry(server, ws, recorder.runtime);

    server.handleTmuxSelectWindow('device-a', '@0_0_bash_1');

    expect(recorder.selectWindowCalls).toEqual([]);
    expect(recorder.requestSnapshotCalls).toBe(1);
  });

  test('rejects select-window ids missing from current snapshot', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    const recorder = createRuntimeRecorder();
    setupEntry(server, ws, recorder.runtime);

    server.handleTmuxSelectWindow('device-a', '@99');

    expect(recorder.selectWindowCalls).toEqual([]);
    expect(recorder.requestSnapshotCalls).toBe(1);
  });

  test('allows select-window ids present in current snapshot', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    const recorder = createRuntimeRecorder();
    setupEntry(server, ws, recorder.runtime);

    server.handleTmuxSelectWindow('device-a', '@1');

    expect(recorder.selectWindowCalls).toEqual(['@1']);
    expect(recorder.requestSnapshotCalls).toBe(0);
  });

  test('rejects invalid pane selects without mutating selected panes', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    ws.data.borshState.selectedPanes['device-a'] = '%1';
    const recorder = createRuntimeRecorder();
    const entry = setupEntry(server, ws, recorder.runtime);

    server.handleTmuxSelect(ws, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1_bad',
      selectToken: new Uint8Array(16).fill(1),
      wantHistory: true,
      cols: null,
      rows: null,
    });
    clearPolling(entry);

    expect(recorder.selectPaneCalls).toEqual([]);
    expect(recorder.requestSnapshotCalls).toBe(1);
    expect(ws.data.borshState.selectedPanes['device-a']).toBe('%1');
    expect(ws.sent).toHaveLength(0);
  });

  test('rejects pane ids that are not inside the requested window', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    const recorder = createRuntimeRecorder();
    const entry = setupEntry(server, ws, recorder.runtime);

    server.handleTmuxSelect(ws, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%2',
      selectToken: new Uint8Array(16).fill(1),
      wantHistory: true,
      cols: null,
      rows: null,
    });
    clearPolling(entry);

    expect(recorder.selectPaneCalls).toEqual([]);
    expect(recorder.requestSnapshotCalls).toBe(1);
    expect(ws.data.borshState.selectedPanes['device-a']).toBeUndefined();
    expect(ws.sent).toHaveLength(0);
  });

  test('allows pane selects that exist in the requested window', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    const recorder = createRuntimeRecorder();
    const entry = setupEntry(server, ws, recorder.runtime);

    server.handleTmuxSelect(ws, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      selectToken: new Uint8Array(16).fill(1),
      wantHistory: true,
      cols: 100,
      rows: 30,
    });
    clearPolling(entry);

    expect(recorder.selectPaneCalls).toEqual([
      { windowId: '@1', paneId: '%1', size: { cols: 100, rows: 30 } },
    ]);
    expect(recorder.requestSnapshotCalls).toBe(0);
    expect(ws.data.borshState.selectedPanes['device-a']).toBe('%1');
    expect(ws.sent).toHaveLength(1);
  });

  test('flushes old pane output before starting a new select transaction', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    ws.data.borshState.selectedPanes['device-a'] = '%1';
    const recorder = createRuntimeRecorder();
    const entry = setupEntry(server, ws, recorder.runtime);

    server.broadcastTerminalOutput('device-a', '%1', new Uint8Array([7, 8]));
    server.handleTmuxSelect(ws, {
      deviceId: 'device-a',
      windowId: '@2',
      paneId: '%2',
      selectToken: new Uint8Array(16).fill(2),
      wantHistory: true,
      cols: null,
      rows: null,
    });
    clearPolling(entry);

    expect(ws.sent.map((frame: Uint8Array) => wsBorsh.decodeEnvelope(frame).kind)).toEqual([
      wsBorsh.KIND_TERM_OUTPUT,
      wsBorsh.KIND_SWITCH_ACK,
    ]);
    const outputEnvelope = wsBorsh.decodeEnvelope(ws.sent[0]);
    const output = wsBorsh.decodePayload(wsBorsh.schema.TermOutputSchema, outputEnvelope.payload);
    expect(output.paneId).toBe('%1');
    expect(Array.from(output.data)).toEqual([7, 8]);
    switchBarrier.cleanupClient(ws);
  });

  test('flushes subscribed pane output before replacing the subscription set', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    ws.data.borshState.subscribedPanes['device-a'] = new Set(['%1']);
    const recorder = createRuntimeRecorder();
    const entry = setupEntry(server, ws, recorder.runtime);

    server.broadcastTerminalOutput('device-a', '%1', new Uint8Array([9]));
    server.handleSubscribePanes(ws, 'device-a', ['%2']);
    clearPolling(entry);

    expect(ws.sent).toHaveLength(1);
    const outputEnvelope = wsBorsh.decodeEnvelope(ws.sent[0]);
    const output = wsBorsh.decodePayload(wsBorsh.schema.TermOutputSchema, outputEnvelope.payload);
    expect(output.paneId).toBe('%1');
    expect(Array.from(output.data)).toEqual([9]);
    expect([...ws.data.borshState.subscribedPanes['device-a']]).toEqual(['%2']);
  });
});

describe('WebSocketServer bell extension', () => {
  beforeAll(() => {
    runMigrations();
    ensureSiteSettingsInitialized();
  });

  test('extends bell event with pane context from snapshot', async () => {
    const server = new WebSocketServer() as any;

    server.connections.set('device-a', {
      runtime: {},
      detachRuntime: () => {},
      clients: new Set(),
      lastSnapshot: {
        deviceId: 'device-a',
        session: {
          id: '$1',
          name: 'tmex',
          windows: [
            {
              id: '@1',
              name: 'main',
              index: 0,
              active: true,
              panes: [
                {
                  id: '%1',
                  windowId: '@1',
                  index: 0,
                  title: 'vim session',
                  currentCommand: 'vim',
                  active: true,
                  width: 80,
                  height: 24,
                },
              ],
            },
          ],
        },
      },
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });

    const result = await server.extendTmuxEvent('device-a', {
      type: 'bell',
      data: {
        paneId: '%1',
      },
    });
    const baseUrl = getSiteSettings().siteUrl;

    expect(result).toEqual({
      type: 'bell',
      data: {
        windowId: '@1',
        paneId: '%1',
        windowIndex: 0,
        paneIndex: 0,
        paneUrl: `${baseUrl}/devices/device-a/windows/%401/panes/%251`,
        paneTitle: 'vim session',
        paneCurrentCommand: 'vim',
      },
    });
  });

  test('throttles bell events per client', async () => {
    const server = new WebSocketServer() as any;
    server.scheduleSnapshot = () => {};
    let shouldAllowCalls = 0;
    const originalShouldAllowBell = sessionStateStore.shouldAllowBell.bind(sessionStateStore);
    sessionStateStore.shouldAllowBell = (() => {
      shouldAllowCalls += 1;
      return shouldAllowCalls === 1;
    }) as any;

    const ws = {
      data: { borshState: createBorshClientState() },
      sent: [] as Uint8Array[],
      send(message: Uint8Array) {
        this.sent.push(message);
      },
    } as any;

    sessionStateStore.create(ws);

    server.connections.set('device-a', {
      runtime: {},
      detachRuntime: () => {},
      clients: new Set([ws]),
      lastSnapshot: null,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });

    await server.broadcastTmuxEvent('device-a', { type: 'bell', data: { paneId: '%1' } });
    await server.broadcastTmuxEvent('device-a', { type: 'bell', data: { paneId: '%1' } });

    expect(ws.sent).toHaveLength(1);

    sessionStateStore.shouldAllowBell = originalShouldAllowBell;
  });

  test('extends notification event with pane context from snapshot', async () => {
    const server = new WebSocketServer() as any;

    server.connections.set('device-a', {
      runtime: {},
      detachRuntime: () => {},
      clients: new Set(),
      lastSnapshot: {
        deviceId: 'device-a',
        session: {
          id: '$1',
          name: 'tmex',
          windows: [
            {
              id: '@1',
              name: 'main',
              index: 0,
              active: true,
              panes: [
                {
                  id: '%1',
                  windowId: '@1',
                  index: 0,
                  title: 'build output',
                  currentCommand: 'make',
                  active: true,
                  width: 80,
                  height: 24,
                },
              ],
            },
          ],
        },
      },
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });

    const result = await server.extendTmuxEvent('device-a', {
      type: 'notification',
      data: {
        paneId: '%1',
        source: 'osc777',
        title: 'Build finished',
        body: 'OK',
      },
    });
    const baseUrl = getSiteSettings().siteUrl;

    expect(result).toEqual({
      type: 'notification',
      data: {
        windowId: '@1',
        paneId: '%1',
        windowIndex: 0,
        paneIndex: 0,
        paneUrl: `${baseUrl}/devices/device-a/windows/%401/panes/%251`,
        paneTitle: 'build output',
        paneCurrentCommand: 'make',
        source: 'osc777',
        title: 'Build finished',
        body: 'OK',
      },
    });
  });

  test('drops empty notification events before broadcast', async () => {
    const server = new WebSocketServer() as any;
    server.scheduleSnapshot = () => {};

    const ws = {
      data: { borshState: createBorshClientState() },
      sent: [] as Uint8Array[],
      send(message: Uint8Array) {
        this.sent.push(message);
      },
    } as any;

    sessionStateStore.create(ws);

    server.connections.set('device-a', {
      runtime: {},
      detachRuntime: () => {},
      clients: new Set([ws]),
      lastSnapshot: null,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });

    await server.broadcastTmuxEvent('device-a', {
      type: 'notification',
      data: { source: 'osc9', body: '' },
    });

    expect(ws.sent).toHaveLength(0);
  });

  test('throttles notification events per client and source', async () => {
    const server = new WebSocketServer() as any;
    server.scheduleSnapshot = () => {};
    updateSiteSettings({ notificationThrottleSeconds: 3 });
    let shouldAllowCalls = 0;
    const originalShouldAllowNotification =
      sessionStateStore.shouldAllowNotification.bind(sessionStateStore);
    sessionStateStore.shouldAllowNotification = (() => {
      shouldAllowCalls += 1;
      return shouldAllowCalls === 1;
    }) as any;

    const ws = {
      data: { borshState: createBorshClientState() },
      sent: [] as Uint8Array[],
      send(message: Uint8Array) {
        this.sent.push(message);
      },
    } as any;

    sessionStateStore.create(ws);

    server.connections.set('device-a', {
      runtime: {},
      detachRuntime: () => {},
      clients: new Set([ws]),
      lastSnapshot: null,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });

    await server.broadcastTmuxEvent('device-a', {
      type: 'notification',
      data: { paneId: '%1', source: 'osc777', title: 'Build', body: 'OK' },
    });
    await server.broadcastTmuxEvent('device-a', {
      type: 'notification',
      data: { paneId: '%1', source: 'osc777', title: 'Build', body: 'OK' },
    });

    expect(ws.sent).toHaveLength(1);

    sessionStateStore.shouldAllowNotification = originalShouldAllowNotification;
    updateSiteSettings({ notificationThrottleSeconds: 3 });
  });
});

describe('WebSocketServer window custom names', () => {
  function makeSnapshot(windowIds: string[]): StateSnapshotPayload {
    return {
      deviceId: 'device-a',
      session: {
        id: '$1',
        name: 'tmex',
        windows: windowIds.map((id, index) => ({
          id,
          name: `win-${index}`,
          index,
          active: index === 0,
          panes: [
            {
              id: `%${index}`,
              windowId: id,
              index: 0,
              title: `title-${index}`,
              active: true,
              width: 80,
              height: 24,
            },
          ],
        })),
      },
    };
  }

  function createBorshWs() {
    return {
      data: { borshState: createBorshClientState() },
      sent: [] as Uint8Array[],
      send(message: Uint8Array) {
        this.sent.push(message);
      },
    } as any;
  }

  function decodeLastSnapshot(ws: any): StateSnapshotPayload {
    const envelope = wsBorsh.decodeEnvelope(ws.sent[ws.sent.length - 1]);
    expect(envelope.kind).toBe(wsBorsh.KIND_STATE_SNAPSHOT);
    return wsBorsh.decodeStateSnapshot(envelope.payload);
  }

  function setupEntry(server: any, snapshot: StateSnapshotPayload | null, ws: any) {
    server.connections.set('device-a', {
      runtime: {},
      detachRuntime: () => {},
      clients: new Set([ws]),
      lastSnapshot: snapshot,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });
  }

  test('rename stores overlay and rebroadcasts snapshot with customName', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    setupEntry(server, makeSnapshot(['@1', '@2']), ws);

    server.renameWindow('device-a', '@1', '  My Window  ');

    const snapshot = decodeLastSnapshot(ws);
    expect(snapshot.session?.windows[0].customName).toBe('My Window');
    expect(snapshot.session?.windows[1].customName).toBeUndefined();
    // lastSnapshot 保持原始数据，不被 overlay 污染
    expect(
      server.connections.get('device-a').lastSnapshot.session.windows[0].customName
    ).toBeUndefined();
  });

  test('empty name clears the overlay', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    setupEntry(server, makeSnapshot(['@1']), ws);

    server.renameWindow('device-a', '@1', 'Custom');
    server.renameWindow('device-a', '@1', '   ');

    const snapshot = decodeLastSnapshot(ws);
    expect(snapshot.session?.windows[0].customName).toBeUndefined();
    expect(server.windowCustomNames.get('device-a')?.has('@1')).toBe(false);
  });

  test('overlay name is truncated to 64 characters', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    setupEntry(server, makeSnapshot(['@1']), ws);

    server.renameWindow('device-a', '@1', 'x'.repeat(100));

    const snapshot = decodeLastSnapshot(ws);
    expect(snapshot.session?.windows[0].customName).toBe('x'.repeat(64));
  });

  test('stale window entries are pruned when snapshot no longer contains them', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshWs();
    setupEntry(server, makeSnapshot(['@1', '@2']), ws);

    server.renameWindow('device-a', '@1', 'Keep');
    server.renameWindow('device-a', '@2', 'Gone');

    server.broadcastStateSnapshot('device-a', makeSnapshot(['@1']));

    const snapshot = decodeLastSnapshot(ws);
    expect(snapshot.session?.windows).toHaveLength(1);
    expect(snapshot.session?.windows[0].customName).toBe('Keep');
    expect(server.windowCustomNames.get('device-a')?.has('@2')).toBe(false);
  });

  test('overlay survives connection entry recreation and applies on device connect', async () => {
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
          }) as any,
        releaseRuntime: () => {},
      },
    }) as any;
    const ws = createBorshWs();
    sessionStateStore.create(ws);
    setupEntry(server, makeSnapshot(['@1']), ws);

    server.renameWindow('device-a', '@1', 'Persisted');

    // 模拟所有 client 断开后 entry 销毁、随后重连
    server.connections.delete('device-a');
    await server.handleDeviceConnect(ws, 'device-a');
    server.broadcastStateSnapshot('device-a', makeSnapshot(['@1']));

    const snapshot = decodeLastSnapshot(ws);
    expect(snapshot.session?.windows[0].customName).toBe('Persisted');
  });
});

describe('WebSocketServer site theme propagation', () => {
  function createStyleRecorder() {
    const recorder = {
      setWindowStyleCalls: [] as string[],
      runtime: {
        async setWindowStyle(style: string) {
          recorder.setWindowStyleCalls.push(style);
        },
      },
    };
    return recorder;
  }

  function setupStyleEntry(
    server: any,
    deviceId: string,
    runtime: ReturnType<typeof createStyleRecorder>['runtime']
  ) {
    server.connections.set(deviceId, {
      runtime,
      detachRuntime: () => {},
      clients: new Set(),
      lastSnapshot: null,
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });
  }

  test('handleSiteThemeChange applies window-style to all connected devices', () => {
    const server = new WebSocketServer() as any;
    const recorderA = createStyleRecorder();
    const recorderB = createStyleRecorder();
    setupStyleEntry(server, 'device-a', recorderA.runtime);
    setupStyleEntry(server, 'device-b', recorderB.runtime);

    server.handleSiteThemeChange('light');

    const expectedLight = 'fg=#616161,bg=#e1e1e1';
    expect(recorderA.setWindowStyleCalls).toEqual([expectedLight]);
    expect(recorderB.setWindowStyleCalls).toEqual([expectedLight]);
  });

  test('handleSiteThemeChange skips devices without connection entry', () => {
    const server = new WebSocketServer() as any;
    const recorderA = createStyleRecorder();
    setupStyleEntry(server, 'device-a', recorderA.runtime);
    // device-b 没有 entry，不应抛错

    server.handleSiteThemeChange('light');

    expect(recorderA.setWindowStyleCalls).toEqual(['fg=#616161,bg=#e1e1e1']);
  });

  test('handleSiteThemeChange dark uses dark theme colors', () => {
    const server = new WebSocketServer() as any;
    const recorder = createStyleRecorder();
    setupStyleEntry(server, 'device-a', recorder.runtime);

    server.handleSiteThemeChange('dark');

    expect(recorder.setWindowStyleCalls).toEqual(['fg=#d0d0d0,bg=#262626']);
  });

  test('handleSiteThemeChange ignores invalid theme value', () => {
    const server = new WebSocketServer() as any;
    const recorder = createStyleRecorder();
    setupStyleEntry(server, 'device-a', recorder.runtime);

    server.handleSiteThemeChange('blue' as any);

    expect(recorder.setWindowStyleCalls).toEqual([]);
  });

  test('handleSiteThemeChange updates currentTheme', () => {
    const server = new WebSocketServer() as any;
    expect(server.currentTheme).toBeNull();

    server.handleSiteThemeChange('light');
    expect(server.currentTheme).toBe('light');

    server.handleSiteThemeChange('dark');
    expect(server.currentTheme).toBe('dark');
  });

  test('applyThemeToDevice applies current theme to a single device', () => {
    const server = new WebSocketServer() as any;
    server.currentTheme = 'light';
    const recorder = createStyleRecorder();
    setupStyleEntry(server, 'device-a', recorder.runtime);

    server.applyThemeToDevice('device-a');

    expect(recorder.setWindowStyleCalls).toEqual(['fg=#616161,bg=#e1e1e1']);
  });

  test('applyThemeToDevice skips when no connection entry', () => {
    const server = new WebSocketServer() as any;
    server.currentTheme = 'dark';
    // 不应抛错
    server.applyThemeToDevice('device-missing');
  });

  test('applyThemeToDevice skips when currentTheme is null', () => {
    const server = new WebSocketServer() as any;
    server.currentTheme = null;
    const recorder = createStyleRecorder();
    setupStyleEntry(server, 'device-a', recorder.runtime);

    server.applyThemeToDevice('device-a');

    expect(recorder.setWindowStyleCalls).toEqual([]);
  });

  test('createDeviceConnectionEntry applies current theme after connect', async () => {
    const server = new WebSocketServer() as any;
    server.currentTheme = 'light';
    const recorder = createStyleRecorder();
    const ws = {
      data: { borshState: createBorshClientState() },
      send() {},
    } as any;
    sessionStateStore.create(ws);

    server.deps.acquireRuntime = async () =>
      ({
        async connect() {},
        subscribe() {
          return () => {};
        },
        requestSnapshot() {},
        disconnect() {},
        setWindowStyle(style: string) {
          recorder.setWindowStyleCalls.push(style);
        },
      }) as any;

    const entry = await server.createDeviceConnectionEntry('device-a', ws);
    expect(entry).not.toBeNull();
    expect(recorder.setWindowStyleCalls).toEqual(['fg=#616161,bg=#e1e1e1']);
  });

  test('broadcastThemeChange signals all panes of connected devices', () => {
    const signaled: Array<[string, 'dark' | 'light']> = [];
    const server = new WebSocketServer() as any;
    const runtime = {
      signalThemeChange(paneId: string, theme: 'dark' | 'light') {
        signaled.push([paneId, theme]);
      },
    };
    server.connections.set('device-a', {
      runtime,
      detachRuntime: () => {},
      clients: new Set(),
      lastSnapshot: {
        deviceId: 'device-a',
        session: {
          id: '$1',
          name: 'tmex',
          windows: [
            {
              id: '@1',
              name: 'w1',
              index: 0,
              active: true,
              panes: [
                {
                  id: '%0',
                  windowId: '@1',
                  index: 0,
                  title: 't',
                  active: true,
                  width: 80,
                  height: 24,
                },
              ],
            },
            {
              id: '@2',
              name: 'w2',
              index: 1,
              active: false,
              panes: [
                {
                  id: '%1',
                  windowId: '@2',
                  index: 0,
                  title: 't',
                  active: true,
                  width: 80,
                  height: 24,
                },
              ],
            },
          ],
        },
      },
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });

    server.broadcastThemeChange('dark');

    expect(signaled).toEqual([
      ['%0', 'dark'],
      ['%1', 'dark'],
    ]);
  });

  test('broadcastThemeChange deduplicates same theme within 1s', () => {
    const signaled: Array<[string, 'dark' | 'light']> = [];
    const server = new WebSocketServer() as any;
    const runtime = {
      signalThemeChange(paneId: string, theme: 'dark' | 'light') {
        signaled.push([paneId, theme]);
      },
    };
    server.connections.set('device-a', {
      runtime,
      detachRuntime: () => {},
      clients: new Set(),
      lastSnapshot: {
        deviceId: 'device-a',
        session: {
          id: '$1',
          name: 'tmex',
          windows: [
            {
              id: '@1',
              name: 'w1',
              index: 0,
              active: true,
              panes: [
                {
                  id: '%0',
                  windowId: '@1',
                  index: 0,
                  title: 't',
                  active: true,
                  width: 80,
                  height: 24,
                },
              ],
            },
          ],
        },
      },
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });

    server.broadcastThemeChange('dark');
    server.broadcastThemeChange('dark');

    expect(signaled).toEqual([['%0', 'dark']]);
  });

  test('broadcastThemeChange allows different theme immediately', () => {
    const signaled: Array<[string, 'dark' | 'light']> = [];
    const server = new WebSocketServer() as any;
    const runtime = {
      signalThemeChange(paneId: string, theme: 'dark' | 'light') {
        signaled.push([paneId, theme]);
      },
    };
    server.connections.set('device-a', {
      runtime,
      detachRuntime: () => {},
      clients: new Set(),
      lastSnapshot: {
        deviceId: 'device-a',
        session: {
          id: '$1',
          name: 'tmex',
          windows: [
            {
              id: '@1',
              name: 'w1',
              index: 0,
              active: true,
              panes: [
                {
                  id: '%0',
                  windowId: '@1',
                  index: 0,
                  title: 't',
                  active: true,
                  width: 80,
                  height: 24,
                },
              ],
            },
          ],
        },
      },
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });

    server.broadcastThemeChange('dark');
    server.broadcastThemeChange('light');

    expect(signaled).toEqual([
      ['%0', 'dark'],
      ['%0', 'light'],
    ]);
  });
});

describe('WebSocketServer resize × theme dedup', () => {
  function createResizeThemeRecorder() {
    const recorder = {
      setWindowStyleCalls: [] as string[],
      signalThemeChangeCalls: [] as Array<[string, 'dark' | 'light']>,
      resizeWindowCalls: [] as Array<[string, number, number]>,
      resizePaneCalls: [] as Array<[string, number, number]>,
      selectLayoutCalls: [] as Array<[string, 'even-horizontal']>,
      applyStackedLayoutCalls: [] as Array<[string, number, number]>,
      runtime: {
        async setWindowStyle(style: string) {
          recorder.setWindowStyleCalls.push(style);
        },
        signalThemeChange(paneId: string, theme: 'dark' | 'light') {
          recorder.signalThemeChangeCalls.push([paneId, theme]);
        },
        resizeWindow(windowId: string, cols: number, rows: number) {
          recorder.resizeWindowCalls.push([windowId, cols, rows]);
        },
        resizePane(paneId: string, cols: number, rows: number) {
          recorder.resizePaneCalls.push([paneId, cols, rows]);
        },
        selectLayout(windowId: string, preset: 'even-horizontal') {
          recorder.selectLayoutCalls.push([windowId, preset]);
        },
        applyStackedLayout(windowId: string, cols: number, rows: number) {
          recorder.applyStackedLayoutCalls.push([windowId, cols, rows]);
        },
      },
    };
    return recorder;
  }

  function setupEntryWithSnapshot(
    server: any,
    deviceId: string,
    runtime: ReturnType<typeof createResizeThemeRecorder>['runtime'],
    windows?: unknown[]
  ) {
    server.connections.set(deviceId, {
      runtime,
      detachRuntime: () => {},
      clients: new Set(),
      lastSnapshot: {
        deviceId,
        session: {
          id: '$1',
          name: 'tmex',
          windows: windows ?? [
            {
              id: '@1',
              name: 'w1',
              index: 0,
              active: true,
              panes: [
                {
                  id: '%0',
                  windowId: '@1',
                  index: 0,
                  title: 't',
                  active: true,
                  width: 80,
                  height: 24,
                },
              ],
            },
          ],
        },
      },
      snapshotTimer: null,
      snapshotPollTimer: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
    });
  }

  test('handleSetWindowStyle triggers broadcastThemeChange when theme differs from lastBroadcastTheme', async () => {
    const server = new WebSocketServer() as any;
    server.currentTheme = 'dark';
    const recorder = createResizeThemeRecorder();
    setupEntryWithSnapshot(server, 'device-a', recorder.runtime);

    server.handleSetWindowStyle('device-a', 'fg=#d0d0d0,bg=#262626');
    await flushAsync();

    expect(recorder.setWindowStyleCalls).toEqual(['fg=#d0d0d0,bg=#262626']);
    expect(recorder.signalThemeChangeCalls).toEqual([['%0', 'dark']]);
  });

  test('handleSetWindowStyle skips broadcastThemeChange when theme unchanged (resize path dedup)', async () => {
    const server = new WebSocketServer() as any;
    server.currentTheme = 'dark';
    const recorder = createResizeThemeRecorder();
    setupEntryWithSnapshot(server, 'device-a', recorder.runtime);

    server.handleSetWindowStyle('device-a', 'fg=#d0d0d0,bg=#262626');
    await flushAsync();
    expect(recorder.signalThemeChangeCalls).toHaveLength(1);

    server.handleSetWindowStyle('device-a', 'fg=#d0d0d0,bg=#262626');
    await flushAsync();
    expect(recorder.signalThemeChangeCalls).toHaveLength(1);
  });

  test('handleSetWindowStyle broadcasts when theme changes between calls', async () => {
    const server = new WebSocketServer() as any;
    const recorder = createResizeThemeRecorder();
    setupEntryWithSnapshot(server, 'device-a', recorder.runtime);

    server.currentTheme = 'dark';
    server.handleSetWindowStyle('device-a', 'fg=#d0d0d0,bg=#262626');
    await flushAsync();
    server.currentTheme = 'light';
    server.handleSetWindowStyle('device-a', 'fg=#616161,bg=#e1e1e1');
    await flushAsync();

    expect(recorder.signalThemeChangeCalls).toEqual([
      ['%0', 'dark'],
      ['%0', 'light'],
    ]);
  });

  test('handleSetWindowStyle skips broadcast when currentTheme is null', () => {
    const server = new WebSocketServer() as any;
    server.currentTheme = null;
    const recorder = createResizeThemeRecorder();
    setupEntryWithSnapshot(server, 'device-a', recorder.runtime);

    server.handleSetWindowStyle('device-a', 'fg=#d0d0d0,bg=#262626');

    expect(recorder.setWindowStyleCalls).toEqual(['fg=#d0d0d0,bg=#262626']);
    expect(recorder.signalThemeChangeCalls).toEqual([]);
  });

  test('handleTermResize skips when single-pane window already at requested size', () => {
    const server = new WebSocketServer() as any;
    const recorder = createResizeThemeRecorder();
    setupEntryWithSnapshot(server, 'device-a', recorder.runtime);

    server.handleTermResize('device-a', '%0', 80, 24);

    expect(recorder.resizePaneCalls).toEqual([]);
  });

  test('handleTermResize resizes when requested size differs from snapshot', () => {
    const server = new WebSocketServer() as any;
    const recorder = createResizeThemeRecorder();
    setupEntryWithSnapshot(server, 'device-a', recorder.runtime);

    server.handleTermResize('device-a', '%0', 100, 30);

    expect(recorder.resizePaneCalls).toEqual([['%0', 100, 30]]);
  });

  // 回归：切换到另一个单 pane window 时，即使本 device 刚 resize 过相同 cols/rows，
  // 目标 window 尺寸不同就必须下发 resize（旧 per-device 缓存会把它吞掉）
  test('handleTermResize resizes another window even after same cols/rows on this device', () => {
    const server = new WebSocketServer() as any;
    const recorder = createResizeThemeRecorder();
    setupEntryWithSnapshot(server, 'device-a', recorder.runtime, [
      {
        id: '@1',
        name: 'w1',
        index: 0,
        active: true,
        panes: [
          { id: '%0', windowId: '@1', index: 0, title: 't', active: true, width: 120, height: 30 },
        ],
      },
      {
        id: '@2',
        name: 'w2',
        index: 1,
        active: false,
        panes: [
          { id: '%1', windowId: '@2', index: 0, title: 't', active: true, width: 80, height: 24 },
        ],
      },
    ]);

    server.handleTermResize('device-a', '%0', 120, 30);
    server.handleTermResize('device-a', '%1', 120, 30);

    expect(recorder.resizePaneCalls).toEqual([['%1', 120, 30]]);
  });

  test('handleTermResize skips multi-pane window already at layout size', () => {
    const server = new WebSocketServer() as any;
    const recorder = createResizeThemeRecorder();
    setupEntryWithSnapshot(server, 'device-a', recorder.runtime, [
      {
        id: '@1',
        name: 'w1',
        index: 0,
        active: true,
        layout: 'b25d,120x30,0,0{60x30,0,0,0,59x30,61,0,1}',
        panes: [
          { id: '%0', windowId: '@1', index: 0, title: 't', active: true, width: 60, height: 30 },
          { id: '%1', windowId: '@1', index: 1, title: 't', active: false, width: 59, height: 30 },
        ],
      },
    ]);

    server.handleTermResize('device-a', '%0', 120, 30);
    expect(recorder.resizeWindowCalls).toEqual([]);

    server.handleTermResize('device-a', '%0', 100, 40);
    expect(recorder.resizeWindowCalls).toEqual([['@1', 100, 40]]);
    expect(recorder.resizePaneCalls).toEqual([]);
  });

  test('handleTermResize falls back to resizePane for pane missing from snapshot', () => {
    const server = new WebSocketServer() as any;
    const recorder = createResizeThemeRecorder();
    setupEntryWithSnapshot(server, 'device-a', recorder.runtime);

    server.handleTermResize('device-a', '%9', 80, 24);

    expect(recorder.resizePaneCalls).toEqual([['%9', 80, 24]]);
  });

  test('handleApplyStackedLayout delegates multi-pane geometry as one runtime operation', () => {
    const server = new WebSocketServer() as any;
    const recorder = createResizeThemeRecorder();
    setupEntryWithSnapshot(server, 'device-a', recorder.runtime, [
      {
        id: '@1',
        name: 'w1',
        index: 0,
        active: true,
        panes: [
          { id: '%0', windowId: '@1', index: 0, title: 't', active: true, width: 40, height: 24 },
          { id: '%1', windowId: '@1', index: 1, title: 't', active: false, width: 39, height: 24 },
        ],
      },
    ]);

    server.handleApplyStackedLayout('device-a', '@1', 42, 24);

    expect(recorder.applyStackedLayoutCalls).toEqual([['@1', 85, 24]]);
    expect(recorder.resizeWindowCalls).toEqual([]);
    expect(recorder.selectLayoutCalls).toEqual([]);
  });

  test('handleSiteThemeUpdate does not call resize-window or resize-pane', () => {
    const server = new WebSocketServer() as any;
    server.currentTheme = 'dark';
    const recorder = createResizeThemeRecorder();
    setupEntryWithSnapshot(server, 'device-a', recorder.runtime);
    const ws = {
      data: { borshState: createBorshClientState() },
      send() {},
    } as any;
    sessionStateStore.create(ws);
    server.connectedClients = new Set([ws]);

    server.handleSiteThemeUpdate(ws, { theme: wsBorsh.SITE_THEME_LIGHT });

    expect(recorder.resizeWindowCalls).toEqual([]);
    expect(recorder.resizePaneCalls).toEqual([]);
  });

  test('handleSetWindowStyle does not call resize-window or resize-pane', () => {
    const server = new WebSocketServer() as any;
    server.currentTheme = 'dark';
    const recorder = createResizeThemeRecorder();
    setupEntryWithSnapshot(server, 'device-a', recorder.runtime);

    server.handleSetWindowStyle('device-a', 'fg=#d0d0d0,bg=#262626');

    expect(recorder.resizeWindowCalls).toEqual([]);
    expect(recorder.resizePaneCalls).toEqual([]);
  });

  test('releaseConnectionEntry clears per-device dedup caches', async () => {
    const server = new WebSocketServer() as any;
    server.currentTheme = 'dark';
    const recorder = createResizeThemeRecorder();
    setupEntryWithSnapshot(server, 'device-a', recorder.runtime);

    server.handleSetWindowStyle('device-a', 'fg=#d0d0d0,bg=#262626');
    await flushAsync();
    expect(server.lastBroadcastTheme.get('device-a')).toBe('dark');

    const entry = server.connections.get('device-a');
    server.releaseConnectionEntry('device-a', entry);
    expect(server.lastBroadcastTheme.has('device-a')).toBe(false);
    expect(server.themeSignalLast.has('device-a')).toBe(false);
  });
});
