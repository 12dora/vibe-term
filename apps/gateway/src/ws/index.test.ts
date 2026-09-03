import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { agentWsHub } from '../agent/ws-hub';
import { ensureSiteSettingsInitialized, getSiteSettings, updateSiteSettings } from '../db';
import { runMigrations } from '../db/migrate';
import { CarrierSwitchController, type DirectCarrier } from '../mesh/rtc/carrier-switch';
import { DataChannelCarrier } from '../mesh/rtc/data-channel-carrier';
import { pairDataChannels } from '../mesh/rtc/test-fakes';
import { sessionStateStore } from './borsh/session-state';
import { switchBarrier } from './borsh/switch-barrier';
import { logTerminalOutputMetricsIfDue } from './gateway-metrics-log';
import { WebSocketServer, payloadNeedsChunking } from './index';
import { TerminalOutputMetrics } from './terminal-output-metrics';
import {
  createBorshTestWs,
  createFakeCarrier,
  createGatewaySession,
  setupConnectionEntry,
} from './test-helpers';
import { gatewayWebSocketSendGuard } from './websocket-send-guard';

// 快照下发路径会同步读 device_tree_order 表，确保所有用例前已建表
beforeAll(() => {
  runMigrations();
});

function createMockWs() {
  return createGatewaySession();
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('WebSocketServer client diagnostics', () => {
  test('records a bounded client implementation from the negotiated hello', async () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshTestWs({
      send(frame) {
        return frame.length;
      },
    });
    const clientImpl = `tmex-fe-${'x'.repeat(100)}`;
    const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
      clientImpl,
      clientVersion: 'test',
      maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
      supportsCompression: false,
      supportsDiffSnapshot: false,
    });

    server.handleOpen(ws);
    await server.handleBorshMessage(ws, wsBorsh.KIND_HELLO_C2S, 1, payload);

    expect(ws.data.borshState.clientImpl).toBe(clientImpl.slice(0, 64));
    server.closeSession(ws, 1000, 'test cleanup');
  });
});

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

  test('keeps the runtime during reconnect grace and releases it on server shutdown', async () => {
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

    const ws = createBorshTestWs({
      session: true,
      send() {},
    });

    const entry = await server.getOrCreateConnectionEntry('device-c', ws);
    entry.clients.add(ws);
    ws.data.borshState.selectedPanes['device-c'] = '%1';

    server.handleDeviceDisconnect(ws, 'device-c');

    expect(released).toEqual([]);
    server.closeAll();
    await Bun.sleep(0);
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

    const ws1 = createBorshTestWs({ session: true });
    const ws2 = createBorshTestWs({ session: true });

    await server.handleDeviceConnect(ws1, 'device-shared');
    await server.handleDeviceConnect(ws2, 'device-shared');

    expect(acquireCalls).toBe(1);
    expect(connectCalls).toBe(1);
    expect(server.connections.get('device-shared')?.clients.size).toBe(2);
  });
});

describe('WebSocketServer malformed Borsh payload', () => {
  function createBorshClient() {
    return createBorshTestWs({ session: true });
  }

  function decodeError(frame: Uint8Array) {
    const envelope = wsBorsh.decodeEnvelope(frame);
    expect(envelope.kind).toBe(wsBorsh.KIND_ERROR);
    return wsBorsh.decodePayload(wsBorsh.schema.ErrorSchema, envelope.payload);
  }

  test('handleMessage converts invalid payload to protocol error without unhandled rejection', async () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshClient();
    ws.data.borshState.negotiated = true;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    const processEvents = process as unknown as {
      on(event: 'unhandledRejection', listener: NodeJS.UnhandledRejectionListener): void;
      off(event: 'unhandledRejection', listener: NodeJS.UnhandledRejectionListener): void;
    };
    processEvents.on('unhandledRejection', onUnhandled);

    const frame = wsBorsh.encodeEnvelope(
      wsBorsh.KIND_DEVICE_CONNECT,
      new Uint8Array([0xff, 0xff]),
      7
    );
    server.handleMessage(ws, Buffer.from(frame));
    await flushAsync();
    processEvents.off('unhandledRejection', onUnhandled);

    expect(unhandled).toEqual([]);
    expect(ws.sent.length).toBe(1);
    const error = decodeError(ws.sent[0]);
    expect(error.code).toBe(wsBorsh.ERROR_PAYLOAD_DECODE_FAILED);
    expect(error.refSeq).toBe(7);
    expect(error.retryable).toBe(false);
  });

  test('canonical command decode errors still send a single protocol error', async () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshClient();
    ws.data.borshState.negotiated = true;

    await server.handleBorshMessage(ws, wsBorsh.KIND_CANONICAL_COMMAND, 11, new Uint8Array([0x01]));

    expect(ws.sent.length).toBe(1);
    const error = decodeError(ws.sent[0]);
    expect(error.code).toBe(wsBorsh.ERROR_PAYLOAD_DECODE_FAILED);
    expect(error.refSeq).toBe(11);
    expect(error.retryable).toBe(false);
  });

  test('handler runtime error is not reported as payload decode failure', async () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshClient();
    ws.data.borshState.negotiated = true;
    server.handleDeviceDisconnect = () => {
      throw new Error('boom');
    };

    const logged: unknown[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    try {
      const payload = wsBorsh.encodePayload(wsBorsh.schema.DeviceDisconnectSchema, {
        deviceId: 'dev-1',
      });
      await server.handleBorshMessage(ws, wsBorsh.KIND_DEVICE_DISCONNECT, 5, payload);

      expect(ws.sent.length).toBe(1);
      const error = decodeError(ws.sent[0]);
      expect(error.code).not.toBe(wsBorsh.ERROR_PAYLOAD_DECODE_FAILED);
      expect(error.message).not.toBe('Payload decode failed');
      expect(error.code).toBe(wsBorsh.ERROR_INTERNAL_ERROR);
      expect(error.refSeq).toBe(5);
      expect(error.retryable).toBe(false);
      expect(
        logged.some(
          (args) =>
            Array.isArray(args) &&
            args.some((arg) => arg instanceof Error && arg.message === 'boom')
        )
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('WebSocketServer snapshot recovery', () => {
  test('does not install per-client snapshot polling for active panes', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshTestWs({
      session: true,
      send() {},
    });

    const entry = setupConnectionEntry(server, {
      deviceId: 'device-watchdog',
      ws,
      runtime: { requestSnapshot() {} },
    });

    const setIntervalSpy = spyOn(globalThis, 'setInterval');
    try {
      server.refreshSnapshotPolling('device-watchdog');
      expect(setIntervalSpy).not.toHaveBeenCalled();

      ws.data.borshState.selectedPanes['device-watchdog'] = '%1';
      server.refreshSnapshotPolling('device-watchdog');
      expect(setIntervalSpy).not.toHaveBeenCalled();

      ws.data.borshState.selectedPanes['device-watchdog'] = null;
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
  test('drops output for panes with no selected or subscribed client before batching', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshTestWs({
      send() {
        return 1;
      },
    });
    ws.data.borshState.selectedPanes['device-interest'] = '%2';
    setupConnectionEntry(server, { deviceId: 'device-interest', ws });
    const push = spyOn(server.terminalOutputBatcher, 'push');

    server.broadcastTerminalOutput('device-interest', '%1', new Uint8Array([1]));
    expect(push).not.toHaveBeenCalled();

    ws.data.borshState.subscribedPanes['device-interest'] = new Set(['%1']);
    server.broadcastTerminalOutput('device-interest', '%1', new Uint8Array([2]));
    expect(push).toHaveBeenCalledTimes(1);
    server.terminalOutputBatcher.discardDevice('device-interest');
    push.mockRestore();
  });

  test('checks pane interest without allocating a client array per output event', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshTestWs({
      send() {
        return 1;
      },
    });
    ws.data.borshState.selectedPanes['device-interest'] = '%1';
    setupConnectionEntry(server, { deviceId: 'device-interest', ws });
    const from = spyOn(Array, 'from');

    server.broadcastTerminalOutput('device-interest', '%1', new Uint8Array([1]));

    expect(from).not.toHaveBeenCalled();
    from.mockRestore();
    server.terminalOutputBatcher.discardDevice('device-interest');
  });

  test('coalesces pending pane output before encoding it for clients', () => {
    const server = new WebSocketServer() as any;
    const frames: Uint8Array[] = [];
    const ws = createBorshTestWs({
      send(frame) {
        frames.push(frame);
        return frame.length;
      },
    });
    ws.data.borshState.selectedPanes['device-batch'] = '%1';
    setupConnectionEntry(server, { deviceId: 'device-batch', ws });

    server.broadcastTerminalOutput('device-batch', '%1', new Uint8Array([1, 2]));
    server.broadcastTerminalOutput('device-batch', '%1', new Uint8Array([3]));

    expect(frames).toHaveLength(0);
    server.terminalOutputBatcher.flushDevice('device-batch');
    expect(frames).toHaveLength(1);

    const envelope = wsBorsh.decodeEnvelope(frames[0] as Uint8Array);
    const payload = wsBorsh.decodePayload(wsBorsh.schema.TermOutputSchema, envelope.payload);
    expect(Array.from(payload.data)).toEqual([1, 2, 3]);
  });

  test('shares one immutable fused frame across clients with the same sequence', () => {
    const server = new WebSocketServer() as any;
    const first = createBorshTestWs();
    const second = createBorshTestWs();
    first.data.borshState.selectedPanes['device-shared'] = '%1';
    second.data.borshState.selectedPanes['device-shared'] = '%1';
    setupConnectionEntry(server, {
      deviceId: 'device-shared',
      clients: new Set([first, second]),
    });

    server.broadcastTerminalOutput('device-shared', '%1', new Uint8Array([1, 2, 3]));
    server.terminalOutputBatcher.flushDevice('device-shared');

    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
    expect(first.sent[0]).toBe(second.sent[0]);

    second.data.borshState.seqGen();
    server.broadcastTerminalOutput('device-shared', '%1', new Uint8Array([4]));
    server.terminalOutputBatcher.flushDevice('device-shared');
    expect(first.sent[1]).not.toBe(second.sent[1]);
  });

  test('stops encoding live output while blocked and resyncs after a skipped frame drains', () => {
    const server = new WebSocketServer() as any;
    let sendCalls = 0;
    let terminateCalls = 0;
    const sent: Uint8Array[] = [];
    const ws = createBorshTestWs({
      send(bytes) {
        sendCalls += 1;
        sent.push(bytes.slice());
        return sendCalls === 1 ? -1 : bytes.byteLength;
      },
      terminate() {
        terminateCalls += 1;
      },
    });
    ws.data.borshState.selectedPanes['device-slow'] = '%1';
    setupConnectionEntry(server, { deviceId: 'device-slow', ws });

    server.broadcastTerminalOutput('device-slow', '%1', new Uint8Array([1]));
    server.terminalOutputBatcher.flushDevice('device-slow');
    server.broadcastTerminalOutput('device-slow', '%1', new Uint8Array([2]));
    server.terminalOutputBatcher.flushDevice('device-slow');

    expect(sendCalls).toBe(1);
    expect(terminateCalls).toBe(0);

    server.handleDrain(ws);

    expect(terminateCalls).toBe(0);
    const gap = sent.find((frame) => {
      try {
        const env = wsBorsh.decodeEnvelopeView(frame);
        if (env.kind !== wsBorsh.KIND_CANONICAL_EVENT) return false;
        const event = wsBorsh.decodeCanonicalEventPayload(env.payload).event;
        return 'SourceGap' in event && 'Stream' in event.SourceGap.scope;
      } catch {
        return false;
      }
    });
    expect(gap).toBeDefined();
  });
});

describe('WebSocketServer frame sizing', () => {
  test('only enters the chunk path when payload exceeds one negotiated frame', () => {
    expect(payloadNeedsChunking(1, 17)).toBe(false);
    expect(payloadNeedsChunking(2, 17)).toBe(true);
    expect(payloadNeedsChunking(64 * 1024, wsBorsh.DEFAULT_MAX_FRAME_BYTES)).toBe(false);
  });

  test('generic response path chunks every kind below the negotiated frame limit', () => {
    const server = new WebSocketServer() as any;
    const sent: Uint8Array[] = [];
    const ws = createBorshTestWs({
      send(frame) {
        sent.push(new Uint8Array(frame));
        return frame.byteLength;
      },
    });
    ws.data.borshState.maxFrameBytes = 128;

    server.sendEnvelope(ws, wsBorsh.KIND_NOTIFY_EVENT, new Uint8Array(512));

    expect(sent.length).toBeGreaterThan(1);
    for (const frame of sent) {
      expect(frame.byteLength).toBeLessThanOrEqual(128);
      expect(wsBorsh.decodeEnvelope(frame).kind).toBe(wsBorsh.KIND_CHUNK);
    }
  });

  test('fused terminal output preserves generic chunk framing and sequence semantics', () => {
    const server = new WebSocketServer() as any;
    const sent: Uint8Array[] = [];
    const ws = createBorshTestWs({
      send(frame) {
        sent.push(frame.slice());
        return frame.byteLength;
      },
    });
    ws.data.borshState.maxFrameBytes = 128;
    const data = new Uint8Array(512).fill(0x7a);

    const payloadBytes = server.sendTermOutput(ws, '设备-a', '%窗格-1', data);

    expect(payloadBytes).toBeGreaterThan(data.byteLength);
    expect(sent.length).toBeGreaterThan(1);
    const reassembler = new wsBorsh.ChunkReassembler();
    let reassembled: wsBorsh.ReassembledMessage | null = null;
    for (const [index, frame] of sent.entries()) {
      expect(frame.byteLength).toBeLessThanOrEqual(128);
      const envelope = wsBorsh.decodeEnvelope(frame);
      expect(envelope.kind).toBe(wsBorsh.KIND_CHUNK);
      expect(envelope.seq).toBe(index + 2);
      const chunk = wsBorsh.decodeChunk(envelope.payload);
      expect(chunk.originalSeq).toBe(1);
      reassembled = reassembler.addChunk(chunk) ?? reassembled;
    }
    expect(reassembled?.kind).toBe(wsBorsh.KIND_TERM_OUTPUT);
    const output = wsBorsh.decodePayload(
      wsBorsh.schema.TermOutputSchema,
      reassembled?.payload ?? new Uint8Array()
    );
    expect(output.deviceId).toBe('设备-a');
    expect(output.paneId).toBe('%窗格-1');
    expect(output.data).toEqual(data);
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
    return createBorshTestWs({ session: true });
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
      resizePaneCalls: [] as Array<[string, number, number]>,
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
        resizePane(paneId: string, cols: number, rows: number) {
          recorder.resizePaneCalls.push([paneId, cols, rows]);
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
    return setupConnectionEntry(server, { ws, runtime, lastSnapshot: snapshot });
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
    expect(recorder.resizePaneCalls).toEqual([]);
    expect(recorder.requestSnapshotCalls).toBe(0);
    expect(ws.data.borshState.selectedPanes['device-a']).toBe('%1');
    expect(ws.sent.length).toBeGreaterThanOrEqual(1);
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

    setupConnectionEntry(server, {
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

    const ws = createBorshTestWs({ session: true });

    setupConnectionEntry(server, { ws });

    await server.broadcastTmuxEvent('device-a', { type: 'bell', data: { paneId: '%1' } });
    await server.broadcastTmuxEvent('device-a', { type: 'bell', data: { paneId: '%1' } });

    expect(ws.sent).toHaveLength(1);

    sessionStateStore.shouldAllowBell = originalShouldAllowBell;
  });

  test('extends notification event with pane context from snapshot', async () => {
    const server = new WebSocketServer() as any;

    setupConnectionEntry(server, {
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

    const ws = createBorshTestWs({ session: true });

    setupConnectionEntry(server, { ws });

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

    const ws = createBorshTestWs({ session: true });

    setupConnectionEntry(server, { ws });

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
    return createBorshTestWs();
  }

  function decodeLastSnapshot(ws: any): StateSnapshotPayload {
    const envelope = wsBorsh.decodeEnvelope(ws.sent[ws.sent.length - 1]);
    expect(envelope.kind).toBe(wsBorsh.KIND_STATE_SNAPSHOT);
    return wsBorsh.decodeStateSnapshot(envelope.payload);
  }

  function setupEntry(server: any, snapshot: StateSnapshotPayload | null, ws: any) {
    setupConnectionEntry(server, { ws, lastSnapshot: snapshot });
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

  test('reuses the loaded tree order across repeated snapshots for one device', () => {
    let loadCalls = 0;
    const server = new WebSocketServer({
      deps: {
        loadDeviceTreeOrder: (deviceId: string) => {
          loadCalls += 1;
          return {
            deviceId,
            windows: ['@2', '@1'],
            panes: {},
          };
        },
      },
    } as any) as any;
    const snapshot = makeSnapshot(['@1', '@2']);

    const first = wsBorsh.decodeStateSnapshot(server.encodeSnapshotWithOverlays(snapshot));
    const second = wsBorsh.decodeStateSnapshot(server.encodeSnapshotWithOverlays(snapshot));

    expect(first.session?.windows.map((window) => window.id)).toEqual(['@2', '@1']);
    expect(second.session?.windows.map((window) => window.id)).toEqual(['@2', '@1']);
    expect(loadCalls).toBe(1);
  });

  test('keeps cached window and pane order coherent after writes', () => {
    let loadCalls = 0;
    const savedWindows: string[][] = [];
    const savedPanes: Array<[string, string[]]> = [];
    const server = new WebSocketServer({
      deps: {
        loadDeviceTreeOrder: (deviceId: string) => {
          loadCalls += 1;
          return {
            deviceId,
            windows: ['@2', '@1'],
            panes: { '@1': ['%2', '%0'] },
          };
        },
        saveWindowOrder: (_deviceId: string, windowIds: string[]) => {
          savedWindows.push([...windowIds]);
        },
        savePaneOrder: (_deviceId: string, windowId: string, paneIds: string[]) => {
          savedPanes.push([windowId, [...paneIds]]);
        },
      },
    } as any) as any;
    const ws = createBorshWs();
    const snapshot = makeSnapshot(['@1', '@2']);
    const session = snapshot.session;
    if (!session) {
      throw new Error('expected test snapshot session');
    }
    session.windows[0].panes.push({
      ...session.windows[0].panes[0],
      id: '%2',
      index: 1,
      active: false,
    });
    setupEntry(server, snapshot, ws);
    const entry = server.connections.get('device-a');
    if (!entry) throw new Error('expected connection entry');
    entry.canonicalClients = new Set([ws]);

    server.encodeSnapshotWithOverlays(snapshot);
    server.reorderWindows('device-a', ['@1', '@2']);

    const afterWindows = decodeLastSnapshot(ws);
    expect(afterWindows.session?.windows.map((window) => window.id)).toEqual(['@1', '@2']);
    expect(afterWindows.session?.windows[0].panes.map((pane) => pane.id)).toEqual(['%2', '%0']);

    server.reorderPanes('device-a', '@1', ['%0', '%2']);

    const afterPanes = decodeLastSnapshot(ws);
    expect(afterPanes.session?.windows.map((window) => window.id)).toEqual(['@1', '@2']);
    expect(afterPanes.session?.windows[0].panes.map((pane) => pane.id)).toEqual(['%0', '%2']);
    expect(loadCalls).toBe(1);
    expect(savedWindows).toEqual([['@1', '@2']]);
    expect(savedPanes).toEqual([['@1', ['%0', '%2']]]);
  });

  test('reloads tree order after the device connection is released', () => {
    let loadCalls = 0;
    const server = new WebSocketServer({
      deps: {
        loadDeviceTreeOrder: (deviceId: string) => {
          loadCalls += 1;
          return { deviceId, windows: [], panes: {} };
        },
        releaseRuntime: () => {},
      },
    } as any) as any;
    const ws = createBorshWs();
    const snapshot = makeSnapshot(['@1']);
    setupEntry(server, snapshot, ws);

    server.encodeSnapshotWithOverlays(snapshot);
    server.releaseConnectionEntry('device-a', server.connections.get('device-a'));
    server.encodeSnapshotWithOverlays(snapshot);

    expect(loadCalls).toBe(2);
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
    setupConnectionEntry(server, { deviceId, runtime });
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
    const ws = createBorshTestWs({
      session: true,
      send() {},
    });

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
    setupConnectionEntry(server, {
      runtime,
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
    setupConnectionEntry(server, {
      runtime,
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
    setupConnectionEntry(server, {
      runtime,
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
    setupConnectionEntry(server, {
      deviceId,
      runtime,
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
      } as StateSnapshotPayload,
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

    server.handleTermResize(createGatewaySession(), 'device-a', '%0', 80, 24);

    expect(recorder.resizePaneCalls).toEqual([]);
  });

  test('handleTermResize resizes when requested size differs from snapshot', () => {
    const server = new WebSocketServer() as any;
    const recorder = createResizeThemeRecorder();
    setupEntryWithSnapshot(server, 'device-a', recorder.runtime);

    server.handleTermResize(createGatewaySession(), 'device-a', '%0', 100, 30);

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

    const session = createGatewaySession();
    server.handleTermResize(session, 'device-a', '%0', 120, 30);
    server.handleTermResize(session, 'device-a', '%1', 120, 30);

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

    const session = createGatewaySession();
    server.handleTermResize(session, 'device-a', '%0', 120, 30);
    expect(recorder.resizeWindowCalls).toEqual([]);

    server.handleTermResize(session, 'device-a', '%0', 100, 40);
    expect(recorder.resizeWindowCalls).toEqual([['@1', 100, 40]]);
    expect(recorder.resizePaneCalls).toEqual([]);
  });

  test('handleTermResize falls back to resizePane for pane missing from snapshot', () => {
    const server = new WebSocketServer() as any;
    const recorder = createResizeThemeRecorder();
    setupEntryWithSnapshot(server, 'device-a', recorder.runtime);

    server.handleTermResize(createGatewaySession(), 'device-a', '%9', 80, 24);

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
    const ws = createBorshTestWs({
      session: true,
      send() {},
    });
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

describe('WebSocketServer carrier drain isolation', () => {
  test('drain from a stale carrier does not advance canonical state', () => {
    const server = new WebSocketServer() as any;
    const session = createGatewaySession({ session: true });
    const stale = createFakeCarrier();
    session.attachCarrier(stale, 'direct');
    expect(session.activeCarrier).toBe(session.primary);

    const canonical = server.getOrCreateCanonicalSession(session);
    const onDrain = spyOn(canonical, 'onDrain');

    server.handleDrain(session, stale);
    expect(onDrain).not.toHaveBeenCalled();

    server.handleDrain(session, session.activeCarrier);
    expect(onDrain).toHaveBeenCalledTimes(1);
    onDrain.mockRestore();
  });

  test('real direct carrier close tells the canonical feed to rebase on primary', () => {
    const server = new WebSocketServer() as any;
    const session = createGatewaySession({ session: true });
    const canonical = server.getOrCreateCanonicalSession(session);
    const onCarrierFallback = spyOn(canonical, 'onCarrierFallback');
    const [local] = pairDataChannels('canonical-fallback');
    const direct = new DataChannelCarrier(local) as DirectCarrier;
    const switcher = new CarrierSwitchController({
      sendControl: () => 'sent',
      deliverInbound: () => {},
    });
    switcher.attachDirect(session, direct);

    local.close();

    expect(session.direct).toBeNull();
    expect(session.activeCarrier).toBe(session.primary);
    expect(onCarrierFallback).toHaveBeenCalledTimes(1);
    onCarrierFallback.mockRestore();
  });
});

describe('WebSocketServer.attachStreamSession', () => {
  test('creates a GatewaySession with the given carrier as primary and routes HELLO', async () => {
    const server = new WebSocketServer();
    const carrier = createFakeCarrier();
    const attached = server.attachStreamSession(carrier);
    expect(server.connectedClients.has(attached.session)).toBe(true);
    expect(attached.session.primary).toBe(carrier);

    const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
      clientImpl: 'stream-session',
      clientVersion: 'test',
      maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
      supportsCompression: false,
      supportsDiffSnapshot: false,
    });
    attached.onMessage(wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, payload, 1));
    await flushAsync();

    expect(carrier.sent.length).toBeGreaterThan(0);
    const envelope = wsBorsh.decodeEnvelope(carrier.sent[0] as Uint8Array);
    expect(envelope.kind).toBe(wsBorsh.KIND_HELLO_S2C);
    attached.onClose();
    expect(server.connectedClients.has(attached.session)).toBe(false);
  });
});

function encodeHelloFrame(clientImpl: string): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
    clientImpl,
    clientVersion: 'test',
    maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
    supportsCompression: false,
    supportsDiffSnapshot: false,
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, payload, 1);
}

describe('WebSocketServer session/carrier close semantics', () => {
  test('closeSession closes both carriers and removes the session from every registry', () => {
    const server = new WebSocketServer();
    const session = createGatewaySession({ session: true });
    const direct = createFakeCarrier();
    server.handleOpen(session);
    session.attachCarrier(direct, 'direct');
    session.switchActiveCarrier(direct);
    server.getOrCreateCanonicalSession(session);
    const entry = setupConnectionEntry(server, { deviceId: 'dev-close', ws: session });
    const removeClient = spyOn(agentWsHub, 'removeClient');
    const cleanupBarrier = spyOn(switchBarrier, 'cleanupClient');

    server.closeSession(session, 1012, 'Gateway runtime restarting');

    expect(session.closed).toBe(true);
    expect(session.direct).toBeNull();
    expect(session.activeCarrier).toBe(session.primary);
    expect((session.primary as ReturnType<typeof createFakeCarrier>).closeCalls).toEqual([
      { code: 1012, reason: 'Gateway runtime restarting' },
    ]);
    expect(direct.closeCalls).toEqual([{ code: 1012, reason: 'Gateway runtime restarting' }]);
    expect(server.connectedClients.has(session)).toBe(false);
    expect(server.canonicalSessions.has(session)).toBe(false);
    expect(sessionStateStore.get(session)).toBeUndefined();
    expect(entry.clients.has(session)).toBe(false);
    expect(removeClient).toHaveBeenCalledWith(session);
    expect(cleanupBarrier).toHaveBeenCalledWith(session);
    removeClient.mockRestore();
    cleanupBarrier.mockRestore();
  });

  test('handleCarrierClose of an already-closed session is a no-op', () => {
    const server = new WebSocketServer();
    const session = createGatewaySession();
    const direct = createFakeCarrier();
    server.handleOpen(session);
    session.attachCarrier(direct, 'direct');
    server.closeSession(session, 1012, 'restart');
    const primaryCloses = (session.primary as ReturnType<typeof createFakeCarrier>).closeCalls
      .length;
    const directCloses = direct.closeCalls.length;

    server.handleCarrierClose(session, session.primary, 1006, 'late bun close');
    server.handleCarrierClose(session, direct, 1006, 'late direct close');

    expect(session.closed).toBe(true);
    expect((session.primary as ReturnType<typeof createFakeCarrier>).closeCalls.length).toBe(
      primaryCloses
    );
    expect(direct.closeCalls.length).toBe(directCloses);
    expect(server.connectedClients.has(session)).toBe(false);
  });

  test('non-active direct close detaches only and the session survives', () => {
    const server = new WebSocketServer();
    const session = createGatewaySession();
    const direct = createFakeCarrier();
    server.handleOpen(session);
    session.attachCarrier(direct, 'direct');
    server.getOrCreateCanonicalSession(session);

    server.handleCarrierClose(session, direct, 1006, 'direct dropped');

    expect(session.closed).toBe(false);
    expect(session.direct).toBeNull();
    expect(session.activeCarrier).toBe(session.primary);
    expect(server.connectedClients.has(session)).toBe(true);
    expect(server.canonicalSessions.has(session)).toBe(true);
    expect((session.primary as ReturnType<typeof createFakeCarrier>).closeCalls).toEqual([]);
  });

  test('active direct close detaches and switches active back to primary', () => {
    const server = new WebSocketServer();
    const session = createGatewaySession();
    const direct = createFakeCarrier();
    server.handleOpen(session);
    session.attachCarrier(direct, 'direct');
    session.switchActiveCarrier(direct);

    server.handleCarrierClose(session, direct, 1006, 'active direct dropped');

    expect(session.closed).toBe(false);
    expect(session.direct).toBeNull();
    expect(session.activeCarrier).toBe(session.primary);
    expect(server.connectedClients.has(session)).toBe(true);
    expect((session.primary as ReturnType<typeof createFakeCarrier>).closeCalls).toEqual([]);
  });

  test('primary close while direct is active closes both and drops later inbound on direct', () => {
    const server = new WebSocketServer();
    const attached = server.attachStreamSession(createFakeCarrier());
    const { session } = attached;
    const direct = createFakeCarrier();
    session.attachCarrier(direct, 'direct');
    session.switchActiveCarrier(direct);
    const canonical = server.getOrCreateCanonicalSession(session);
    const onDrain = spyOn(canonical, 'onDrain');

    server.handleCarrierClose(session, session.primary, 1006, 'primary closed');

    expect(session.closed).toBe(true);
    expect(direct.closeCalls).toEqual([{ code: 1006, reason: 'primary closed' }]);
    expect(server.connectedClients.has(session)).toBe(false);

    const sentBefore = direct.sent.length;
    attached.onMessage(encodeHelloFrame('after-close'));
    server.handleMessage(session, Buffer.from(encodeHelloFrame('after-close-direct')));
    server.handleDrain(session, direct);
    expect(direct.sent.length).toBe(sentBefore);
    expect(onDrain).not.toHaveBeenCalled();
    onDrain.mockRestore();
  });

  test('attachStreamSession onClose while direct is active closes both carriers', () => {
    const server = new WebSocketServer();
    const primary = createFakeCarrier();
    const attached = server.attachStreamSession(primary);
    const direct = createFakeCarrier();
    attached.session.attachCarrier(direct, 'direct');
    attached.session.switchActiveCarrier(direct);

    attached.onClose();

    expect(attached.session.closed).toBe(true);
    expect(primary.closeCalls.length).toBe(1);
    expect(direct.closeCalls.length).toBe(1);
    expect(server.connectedClients.has(attached.session)).toBe(false);
  });

  test('metrics snapshot covers every attached carrier and logs carrier field names', () => {
    const server = new WebSocketServer();
    const session = createGatewaySession({
      carrier: createFakeCarrier({ send: () => 'backpressure', bufferedAmount: 5 }),
    });
    const direct = createFakeCarrier({ send: () => 'backpressure', bufferedAmount: 7 });
    server.handleOpen(session);
    session.attachCarrier(direct, 'direct');
    session.switchActiveCarrier(direct);
    gatewayWebSocketSendGuard.sendFrames(session.primary, [new Uint8Array([1])]);
    gatewayWebSocketSendGuard.sendFrames(direct, [new Uint8Array([2])]);

    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((message: unknown) => {
      if (typeof message === 'string') logs.push(message);
    });
    try {
      logTerminalOutputMetricsIfDue({
        connectedClients: server.connectedClients,
        connections: server.connections,
        canonicalSessions: server.canonicalSessions,
        terminalOutputBatcher: server.terminalOutputBatcher,
        terminalOutputMetrics: new TerminalOutputMetrics(1, 0),
        gatewayActivityMetrics: server.gatewayActivityMetrics,
      });
    } finally {
      logSpy.mockRestore();
      gatewayWebSocketSendGuard.forget(session.primary);
      gatewayWebSocketSendGuard.forget(direct);
      server.closeSession(session, 1000, 'metrics cleanup');
    }

    const metricsLog = logs.find((line) => line.includes('[ws-metrics] terminal_output'));
    expect(metricsLog).toBeDefined();
    expect(metricsLog).toContain('ws_backpressured_carriers=2');
    expect(metricsLog).toContain('ws_unavailable_carriers=0');
    expect(metricsLog).not.toContain('ws_backpressured_sessions=');
    expect(metricsLog).not.toContain('ws_unavailable_sessions=');
  });
});

describe('LegacyFeedBroadcaster pane observer counts', () => {
  test('skips batching when nobody observes and returns counts to zero after disconnect', () => {
    const server = new WebSocketServer() as any;
    const ws = createBorshTestWs({
      send() {
        return 1;
      },
    });
    setupConnectionEntry(server, { deviceId: 'device-obs', ws });
    const push = spyOn(server.terminalOutputBatcher, 'push');
    const feed = server.feed;

    server.broadcastTerminalOutput('device-obs', '%1', new Uint8Array([1]));
    expect(push).not.toHaveBeenCalled();
    expect(feed.legacyPaneObserverCount('device-obs', '%1')).toBe(0);

    ws.data.borshState.selectedPanes['device-obs'] = '%1';
    feed.syncLegacyPaneObservers(ws, 'device-obs');
    expect(feed.legacyPaneObserverCount('device-obs', '%1')).toBe(1);

    server.broadcastTerminalOutput('device-obs', '%1', new Uint8Array([2]));
    expect(push).toHaveBeenCalledTimes(1);

    feed.releaseLegacyPaneObservers(ws, 'device-obs');
    expect(feed.legacyPaneObserverCount('device-obs', '%1')).toBe(0);

    server.broadcastTerminalOutput('device-obs', '%1', new Uint8Array([3]));
    expect(push).toHaveBeenCalledTimes(1);

    server.terminalOutputBatcher.discardDevice('device-obs');
    push.mockRestore();
  });
});
