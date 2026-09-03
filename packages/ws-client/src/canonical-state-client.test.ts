import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { CanonicalStateClient, type CanonicalStateClientOptions } from './canonical-state-client';
import type {
  EncodedGatewayCommand,
  GatewayTransportCommand,
  GatewayTransportEvent,
} from './transport-types';

const SERVER_EPOCH = new Uint8Array(16).fill(0x11);
const PANE_EPOCH = new Uint8Array(16).fill(0x22);
const METADATA_EPOCH = new Uint8Array(16).fill(0x33);
const HISTORY_EPOCH = new Uint8Array(16).fill(0x44);
const REQUEST_ID = new Uint8Array(16).fill(0x55);

function key(entityKind: number, nativeId: string): wsBorsh.SourceEntityKey {
  return { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, entityKind, nativeId };
}

function metadataRecords(title = 'shell'): wsBorsh.SourceMetadataRecord[] {
  const device = key(wsBorsh.SOURCE_ENTITY_DEVICE, 'device-a');
  const server = key(wsBorsh.SOURCE_ENTITY_SERVER, 'server');
  const session = key(wsBorsh.SOURCE_ENTITY_SESSION, '$1');
  const window = key(wsBorsh.SOURCE_ENTITY_WINDOW, '@1');
  const pane = key(wsBorsh.SOURCE_ENTITY_PANE, '%1');
  return [
    {
      key: device,
      parent: null,
      fields: [{ field: wsBorsh.SOURCE_FIELD_NAME, value: { String: 'Device' } }],
    },
    { key: server, parent: device, fields: [] },
    {
      key: session,
      parent: server,
      fields: [{ field: wsBorsh.SOURCE_FIELD_NAME, value: { String: 'main' } }],
    },
    {
      key: window,
      parent: session,
      fields: [
        { field: wsBorsh.SOURCE_FIELD_NAME, value: { String: 'window' } },
        { field: wsBorsh.SOURCE_FIELD_INDEX, value: { U32: 0 } },
        { field: wsBorsh.SOURCE_FIELD_ACTIVE, value: { Bool: true } },
      ],
    },
    {
      key: pane,
      parent: window,
      fields: [
        { field: wsBorsh.SOURCE_FIELD_INDEX, value: { U32: 0 } },
        { field: wsBorsh.SOURCE_FIELD_ACTIVE, value: { Bool: true } },
        { field: wsBorsh.SOURCE_FIELD_WIDTH, value: { U16: 80 } },
        { field: wsBorsh.SOURCE_FIELD_HEIGHT, value: { U16: 24 } },
        { field: wsBorsh.SOURCE_FIELD_TITLE, value: { String: title } },
        { field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Bytes16: PANE_EPOCH } },
      ],
    },
  ];
}

function metadataRecordsForDevice(
  deviceId: string,
  serverEpoch: Uint8Array
): wsBorsh.SourceMetadataRecord[] {
  const remapKey = (source: wsBorsh.SourceEntityKey): wsBorsh.SourceEntityKey => ({
    ...source,
    deviceId,
    serverEpoch,
  });
  return metadataRecords().map((record) => ({
    ...record,
    key: remapKey(record.key),
    parent: record.parent ? remapKey(record.parent) : null,
  }));
}

function decode(message: EncodedGatewayCommand): wsBorsh.CanonicalCommand {
  expect(message.kind).toBe(wsBorsh.KIND_CANONICAL_COMMAND);
  return wsBorsh.decodeCanonicalCommandPayload(message.payload).command;
}

type HarnessOptions = Pick<
  CanonicalStateClientOptions,
  | 'subscriptionRetryMaxAttempts'
  | 'maxMetadataBufferedBytes'
  | 'metadataAssemblyTimeoutMs'
  | 'metadataRecoveryDelayMs'
  | 'onMetadataGap'
>;

function createHarness(
  maxFrameBytes = 32 * 1024,
  subscriptionRetryMs?: number,
  options: HarnessOptions = {}
) {
  const messages: EncodedGatewayCommand[] = [];
  const events: GatewayTransportEvent[] = [];
  let id = 0;
  const client = new CanonicalStateClient({
    emit: (event) => events.push(event),
    send: (message) => {
      messages.push(message);
      return 'sent';
    },
    effectiveMaxFrameBytes: () => maxFrameBytes,
    createId: () => new Uint8Array(16).fill(++id),
    subscriptionRetryMs,
    ...options,
  });
  return { client, messages, events };
}

function installMetadata(client: CanonicalStateClient, revision = 1n): void {
  client.handleEvent({
    SourceMetadataSnapshot: {
      metadataEpoch: METADATA_EPOCH,
      revision,
      snapshotId: new Uint8Array(16).fill(0x66),
      chunkIndex: 0,
      totalChunks: 1,
      records: metadataRecords(),
    },
  });
}

function feedReady(gatewayByte: number): wsBorsh.CanonicalEvent {
  return {
    FeedReady: {
      gatewayEpoch: new Uint8Array(16).fill(gatewayByte),
      maxFrameBytes: 32 * 1024,
      maxActivePanes: 64,
      maxHotPanes: 128,
      maxScreenBytes: 512 * 1024,
      maxHistoryPageBytes: 256 * 1024,
    },
  };
}

describe('CanonicalStateClient', () => {
  test('runs the canonical subscribe, output, input, resize, screen, history, gap and re-sync flow', () => {
    const { client, messages, events } = createHarness();
    client.activate();
    expect(decode(messages[0] as EncodedGatewayCommand)).toEqual({
      SetPaneSubscriptions: { generation: 1n, activePanes: [], hotPanes: [] },
    });

    const subscribe: GatewayTransportCommand = {
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    };
    client.sendCommand(subscribe);
    const bootstrap = decode(messages.at(-1) as EncodedGatewayCommand);
    expect(bootstrap).toHaveProperty('SetPaneSubscriptions');
    if (!('SetPaneSubscriptions' in bootstrap)) throw new Error('missing bootstrap subscription');
    expect(bootstrap.SetPaneSubscriptions.activePanes[0]?.pane.serverEpoch).toEqual(
      new Uint8Array(16)
    );

    installMetadata(client);
    const resolved = decode(messages.at(-1) as EncodedGatewayCommand);
    if (!('SetPaneSubscriptions' in resolved)) throw new Error('missing resolved subscription');
    expect(resolved.SetPaneSubscriptions.generation).toBe(3n);
    expect(resolved.SetPaneSubscriptions.activePanes[0]?.pane).toEqual({
      deviceId: 'device-a',
      serverEpoch: SERVER_EPOCH,
      paneId: '%1',
    });
    expect(events.find((event) => event.type === 'metadata-snapshot')).toMatchObject({
      snapshot: { deviceId: 'device-a', session: { id: '$1', name: 'main' } },
    });

    client.handleEvent({
      SubscriptionApplied: {
        generation: 3n,
        activePanes: [{ deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' }],
        hotPanes: [],
        rejected: [],
      },
    });
    expect(events.at(-1)).toEqual({
      type: 'rebase-required',
      deviceId: 'device-a',
      paneId: '%1',
      reason: 'cache_evicted',
    });

    client.sendCommand({
      type: 'request-pane-screen',
      requestId: REQUEST_ID,
      deviceId: 'device-a',
      paneId: '%1',
      byteLimit: 4096,
    });
    expect(decode(messages.at(-1) as EncodedGatewayCommand)).toHaveProperty('RequestScreen');
    client.handleEvent({
      ScreenBegin: {
        requestId: REQUEST_ID,
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
        paneEpoch: PANE_EPOCH,
        baseSeq: 5n,
        rows: 24,
        cols: 80,
        modes: 3,
        totalBytes: 4,
      },
    });
    client.handleEvent({
      ScreenChunk: { requestId: REQUEST_ID, offset: 0, data: new TextEncoder().encode('base') },
    });
    client.handleEvent({
      ScreenCommit: {
        requestId: REQUEST_ID,
        totalBytes: 4,
        historyCursor: {
          paneEpoch: PANE_EPOCH,
          historyEpoch: HISTORY_EPOCH,
          beforeLine: 100,
        },
      },
    });
    const screen = events.at(-1);
    expect(screen?.type).toBe('screen-snapshot');
    if (!screen || screen.type !== 'screen-snapshot') throw new Error('missing screen snapshot');
    expect(new TextDecoder().decode(screen.snapshot.data)).toBe('base');
    expect(screen.snapshot.baseSeq).toBe(5n);

    client.handleEvent({
      PaneData: {
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
        paneEpoch: PANE_EPOCH,
        seqStart: 5n,
        seqEnd: 8n,
        data: new TextEncoder().encode('out'),
      },
    });
    const output = events.at(-1);
    expect(output?.type).toBe('terminal-data');
    if (!output || output.type !== 'terminal-data') throw new Error('missing terminal data');
    expect(output.frame.seqStart).toBe(5n);
    expect(new TextDecoder().decode(output.frame.data)).toBe('out');

    client.sendCommand({
      type: 'terminal-input',
      deviceId: 'device-a',
      paneId: '%1',
      data: 'x',
      isComposing: false,
    });
    const input = decode(messages.at(-1) as EncodedGatewayCommand);
    expect(input).toHaveProperty('TerminalInput');
    if (!('TerminalInput' in input)) throw new Error('missing input');
    expect(new TextDecoder().decode(input.TerminalInput.data)).toBe('x');
    expect(input.TerminalInput.paneEpoch).toEqual(PANE_EPOCH);

    client.sendCommand({
      type: 'terminal-resize',
      deviceId: 'device-a',
      paneId: '%1',
      cols: 100,
      rows: 30,
    });
    const resize = decode(messages.at(-1) as EncodedGatewayCommand);
    expect(resize).toHaveProperty('ResizePaneV11');
    if (!('ResizePaneV11' in resize)) throw new Error('missing resize');
    expect(resize.ResizePaneV11).toMatchObject({
      cols: 100,
      rows: 30,
      geometryReason: wsBorsh.CANONICAL_GEOMETRY_REASON_CHANGE,
      sizeEpoch: 1n,
    });

    client.sendCommand({
      type: 'request-pane-history',
      requestId: REQUEST_ID,
      deviceId: 'device-a',
      paneId: '%1',
      cursor: { paneEpoch: PANE_EPOCH, historyEpoch: HISTORY_EPOCH, beforeLine: 100 },
      byteLimit: 4096,
    });
    const historyRequest = decode(messages.at(-1) as EncodedGatewayCommand);
    expect(historyRequest).toHaveProperty('RequestHistory');
    if (!('RequestHistory' in historyRequest)) throw new Error('missing history request');
    expect(historyRequest.RequestHistory.beforeCursor?.beforeLine).toBe(100);
    client.handleEvent({
      HistoryBegin: {
        requestId: REQUEST_ID,
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
        paneEpoch: PANE_EPOCH,
        historyEpoch: HISTORY_EPOCH,
        lineStart: 90,
        lineEnd: 100,
        truncated: false,
        totalBytes: 3,
      },
    });
    client.handleEvent({
      HistoryChunk: { requestId: REQUEST_ID, offset: 0, data: new TextEncoder().encode('old') },
    });
    client.handleEvent({
      HistoryCommit: {
        requestId: REQUEST_ID,
        totalBytes: 3,
        nextCursor: {
          paneEpoch: PANE_EPOCH,
          historyEpoch: HISTORY_EPOCH,
          beforeLine: 90,
        },
      },
    });
    const page = events.at(-1);
    expect(page?.type).toBe('history-page');
    if (!page || page.type !== 'history-page') throw new Error('missing history page');
    expect(new TextDecoder().decode(page.page.data)).toBe('old');
    expect(page.page.nextCursor?.beforeLine).toBe(90);

    client.handleEvent({
      SourceGap: {
        reason: wsBorsh.SOURCE_GAP_REASON_CACHE_EVICTED,
        scope: {
          Pane: {
            pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
            expectedPaneEpoch: PANE_EPOCH,
            availablePaneEpoch: PANE_EPOCH,
            expectedSeq: 8n,
            availableSeq: 12n,
          },
        },
      },
    });
    expect(events.at(-1)).toEqual({
      type: 'rebase-required',
      deviceId: 'device-a',
      paneId: '%1',
      reason: 'cache_evicted',
    });
    client.sendCommand({
      type: 'request-pane-screen',
      requestId: new Uint8Array(16).fill(0x77),
      deviceId: 'device-a',
      paneId: '%1',
      byteLimit: 4096,
    });
    expect(decode(messages.at(-1) as EncodedGatewayCommand)).toHaveProperty('RequestScreen');
  });

  test('splits paste into semantic TerminalInput commands under the negotiated frame cap', () => {
    const { client, messages } = createHarness(160);
    client.activate();
    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    installMetadata(client);
    messages.length = 0;

    expect(
      client.sendCommand({
        type: 'terminal-paste',
        deviceId: 'device-a',
        paneId: '%1',
        data: 'z'.repeat(256),
      })
    ).toBe('sent');

    const commands = messages.map(decode);
    expect(commands.length).toBeGreaterThan(1);
    const ids = new Set<string>();
    let body = '';
    for (const [index, command] of commands.entries()) {
      expect(messages[index]?.payload.byteLength ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
        160 - 16
      );
      if (!('TerminalInput' in command)) throw new Error('expected TerminalInput chunk');
      ids.add(Array.from(command.TerminalInput.inputId).join(','));
      body += new TextDecoder().decode(command.TerminalInput.data);
    }
    expect(ids.size).toBe(commands.length);
    expect(body).toBe('z'.repeat(256));
  });

  test('preserves the legacy 1024-character paste write boundaries', () => {
    const { client, messages } = createHarness();
    client.activate();
    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    installMetadata(client);
    messages.length = 0;

    client.sendCommand({
      type: 'terminal-paste',
      deviceId: 'device-a',
      paneId: '%1',
      data: 'z'.repeat(2_050),
    });

    expect(
      messages.map((message) => {
        const command = decode(message);
        if (!('TerminalInput' in command)) throw new Error('expected TerminalInput chunk');
        return command.TerminalInput.data.byteLength;
      })
    ).toEqual([1_024, 1_024, 2]);
  });

  test('keeps composing input as the same no-op as the legacy server path', () => {
    const { client, messages } = createHarness();
    client.activate();
    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    installMetadata(client);
    const before = messages.length;
    expect(
      client.sendCommand({
        type: 'terminal-input',
        deviceId: 'device-a',
        paneId: '%1',
        data: 'composition',
        isComposing: true,
      })
    ).toBe('sent');
    expect(messages).toHaveLength(before);
  });

  test('aggregates per-device intents into one global replacement set', () => {
    const { client, messages } = createHarness();
    client.activate();
    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-b',
      generation: 1n,
      paneIds: ['%2'],
    });
    let command = decode(messages.at(-1) as EncodedGatewayCommand);
    if (!('SetPaneSubscriptions' in command)) throw new Error('missing global subscription');
    expect(command.SetPaneSubscriptions.activePanes.map((item) => item.pane.deviceId)).toEqual([
      'device-a',
      'device-b',
    ]);

    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 2n,
      paneIds: [],
    });
    command = decode(messages.at(-1) as EncodedGatewayCommand);
    if (!('SetPaneSubscriptions' in command)) throw new Error('missing replacement subscription');
    expect(command.SetPaneSubscriptions.activePanes.map((item) => item.pane.deviceId)).toEqual([
      'device-b',
    ]);
  });

  test('continues after a failover-injected subscription generation', () => {
    const { client, messages } = createHarness();
    client.activate();
    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    installMetadata(client);
    client.handleEvent({
      SubscriptionApplied: {
        generation: 9n,
        activePanes: [{ deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' }],
        hotPanes: [],
        rejected: [],
      },
    });

    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-b',
      generation: 1n,
      paneIds: ['%2'],
    });

    const command = decode(messages.at(-1) as EncodedGatewayCommand);
    if (!('SetPaneSubscriptions' in command)) throw new Error('missing replacement subscription');
    expect(command.SetPaneSubscriptions.generation).toBe(10n);
  });

  test('retries an in-flight content request after the feed epoch changes', () => {
    const { client, messages } = createHarness();
    client.activate();
    client.handleEvent(feedReady(1));
    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    installMetadata(client);
    client.sendCommand({
      type: 'request-pane-screen',
      requestId: REQUEST_ID,
      deviceId: 'device-a',
      paneId: '%1',
      byteLimit: 4_096,
    });
    const before = messages.length;

    client.handleEvent(feedReady(2));
    expect(messages).toHaveLength(before);
    installMetadata(client, 2n);

    expect(messages).toHaveLength(before + 2);
    expect(
      messages
        .slice(before)
        .map(decode)
        .some((command) => 'SetPaneSubscriptions' in command)
    ).toBe(true);
    const retried = decode(messages.at(-1) as EncodedGatewayCommand);
    if (!('RequestScreen' in retried)) throw new Error('missing retried screen request');
    expect(retried.RequestScreen.requestId).toEqual(REQUEST_ID);
  });

  test('retries an in-flight content request after a socket reconnect', () => {
    const { client, messages } = createHarness();
    client.activate();
    installMetadata(client);
    client.sendCommand({
      type: 'request-pane-screen',
      requestId: REQUEST_ID,
      deviceId: 'device-a',
      paneId: '%1',
      byteLimit: 4_096,
    });
    client.suspend();
    client.activate();
    const beforeMetadata = messages.length;

    client.handleEvent(feedReady(2));
    installMetadata(client, 2n);

    expect(messages.length).toBeGreaterThan(beforeMetadata);
    const retried = decode(messages.at(-1) as EncodedGatewayCommand);
    if (!('RequestScreen' in retried)) throw new Error('missing reconnected screen request');
    expect(retried.RequestScreen.requestId).toEqual(REQUEST_ID);
  });

  test('retries a screen request after a retryable canonical error', async () => {
    const { client, messages } = createHarness();
    client.activate();
    installMetadata(client);
    client.sendCommand({
      type: 'request-pane-screen',
      requestId: REQUEST_ID,
      deviceId: 'device-a',
      paneId: '%1',
      byteLimit: 4_096,
    });
    const before = messages.length;

    client.handleEvent({
      Error: {
        requestId: REQUEST_ID,
        code: wsBorsh.ERROR_TMUX_NOT_READY,
        message: 'screen unavailable',
        retryable: true,
      },
    });
    await Bun.sleep(70);

    expect(messages).toHaveLength(before + 1);
    const retried = decode(messages.at(-1) as EncodedGatewayCommand);
    if (!('RequestScreen' in retried)) throw new Error('missing retried screen request');
    expect(retried.RequestScreen.requestId).toEqual(REQUEST_ID);
    client.dispose();
  });

  test('moves a scheduled content retry back to the transport queue when suspended', async () => {
    const { client, messages } = createHarness();
    const command: GatewayTransportCommand = {
      type: 'request-pane-screen',
      requestId: REQUEST_ID,
      deviceId: 'device-a',
      paneId: '%1',
      byteLimit: 4_096,
    };
    client.activate();
    installMetadata(client);
    client.sendCommand(command);
    client.handleEvent({
      Error: {
        requestId: REQUEST_ID,
        code: wsBorsh.ERROR_TMUX_NOT_READY,
        message: 'screen unavailable',
        retryable: true,
      },
    });
    const beforeSuspend = messages.length;

    client.suspend();

    expect(client.takePendingCommands()).toEqual([command]);
    await Bun.sleep(70);
    expect(messages).toHaveLength(beforeSuspend);
    client.dispose();
  });

  test('retries an in-flight screen after a stream gap clears a partial transaction', () => {
    const { client, messages } = createHarness();
    client.activate();
    installMetadata(client);
    client.sendCommand({
      type: 'request-pane-screen',
      requestId: REQUEST_ID,
      deviceId: 'device-a',
      paneId: '%1',
      byteLimit: 4_096,
    });
    client.handleEvent({
      ScreenBegin: {
        requestId: REQUEST_ID,
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
        paneEpoch: PANE_EPOCH,
        baseSeq: 0n,
        rows: 24,
        cols: 80,
        modes: 0,
        totalBytes: 2,
      },
    });
    client.handleEvent({
      ScreenChunk: { requestId: REQUEST_ID, offset: 0, data: new Uint8Array([1]) },
    });
    const before = messages.length;

    client.handleEvent({
      SourceGap: {
        reason: wsBorsh.SOURCE_GAP_REASON_CACHE_EVICTED,
        scope: { Stream: {} },
      },
    });

    const sent = messages.slice(before).map(decode);
    expect(sent.some((command) => 'SetPaneSubscriptions' in command)).toBe(true);
    expect(sent.some((command) => 'RequestScreen' in command)).toBe(true);
  });

  test('keeps metadata and content transactions atomic on gaps and incomplete commits', () => {
    const { client, events } = createHarness();
    client.activate();
    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    const records = metadataRecords();
    client.handleEvent({
      SourceMetadataSnapshot: {
        metadataEpoch: METADATA_EPOCH,
        revision: 1n,
        snapshotId: REQUEST_ID,
        chunkIndex: 0,
        totalChunks: 2,
        records: records.slice(0, 3),
      },
    });
    expect(events.some((event) => event.type === 'metadata-snapshot')).toBe(false);
    client.handleEvent({
      SourceMetadataSnapshot: {
        metadataEpoch: METADATA_EPOCH,
        revision: 1n,
        snapshotId: REQUEST_ID,
        chunkIndex: 1,
        totalChunks: 2,
        records: records.slice(3),
      },
    });
    expect(events.filter((event) => event.type === 'metadata-snapshot')).toHaveLength(1);

    events.length = 0;
    client.sendCommand({
      type: 'request-pane-screen',
      requestId: REQUEST_ID,
      deviceId: 'device-a',
      paneId: '%1',
      byteLimit: 4_096,
    });
    client.handleEvent({
      ScreenBegin: {
        requestId: REQUEST_ID,
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
        paneEpoch: PANE_EPOCH,
        baseSeq: 0n,
        rows: 24,
        cols: 80,
        modes: 0,
        totalBytes: 2,
      },
    });
    client.handleEvent({
      ScreenChunk: { requestId: REQUEST_ID, offset: 1, data: new Uint8Array([1]) },
    });
    client.handleEvent({
      ScreenCommit: { requestId: REQUEST_ID, totalBytes: 2, historyCursor: null },
    });
    expect(events.some((event) => event.type === 'screen-snapshot')).toBe(false);
    expect(events.some((event) => event.type === 'rebase-required')).toBe(true);
  });

  test('rejects a duplicate metadata snapshot chunk without applying a partial snapshot', () => {
    const { client, events } = createHarness();
    client.activate();
    const first = metadataRecords().slice(0, 3);
    const event = {
      metadataEpoch: METADATA_EPOCH,
      revision: 1n,
      snapshotId: REQUEST_ID,
      chunkIndex: 0,
      totalChunks: 2,
      records: first,
    };

    client.handleEvent({ SourceMetadataSnapshot: event });
    client.handleEvent({ SourceMetadataSnapshot: event });

    expect(events).toEqual([{ type: 'rebase-required', reason: 'metadata_gap' }]);
  });

  test('bounds concurrent partial metadata snapshot assemblies', () => {
    const { client, events } = createHarness();
    client.activate();
    for (let index = 0; index < 9; index += 1) {
      client.handleEvent({
        SourceMetadataSnapshot: {
          metadataEpoch: METADATA_EPOCH,
          revision: 1n,
          snapshotId: new Uint8Array(16).fill(index + 1),
          chunkIndex: 0,
          totalChunks: 2,
          records: metadataRecords().slice(0, 1),
        },
      });
    }

    expect(events).toEqual([{ type: 'rebase-required', reason: 'metadata_gap' }]);
  });

  test('bounds buffered metadata bytes and expires incomplete snapshot assemblies', async () => {
    const partial = {
      metadataEpoch: METADATA_EPOCH,
      revision: 1n,
      snapshotId: REQUEST_ID,
      chunkIndex: 0,
      totalChunks: 2,
      records: metadataRecords().slice(0, 1),
    };
    const chunkBytes = wsBorsh.encodeCanonicalEventPayload({
      SourceMetadataSnapshot: partial,
    }).byteLength;
    const bounded = createHarness(32 * 1024, undefined, {
      maxMetadataBufferedBytes: chunkBytes - 1,
    });
    bounded.client.activate();
    bounded.client.handleEvent({ SourceMetadataSnapshot: partial });

    expect(bounded.events).toEqual([{ type: 'rebase-required', reason: 'metadata_gap' }]);
    bounded.client.dispose();

    const expiring = createHarness(32 * 1024, undefined, {
      metadataAssemblyTimeoutMs: 2,
    });
    expiring.client.activate();
    expiring.client.handleEvent({ SourceMetadataSnapshot: partial });
    await Bun.sleep(10);

    expect(expiring.events).toEqual([{ type: 'rebase-required', reason: 'metadata_gap' }]);
    expiring.client.dispose();
  });

  test('discards an older partial snapshot after a newer snapshot commits for the device', () => {
    const { client, events } = createHarness();
    const records = metadataRecords();
    client.activate();
    client.handleEvent({
      SourceMetadataSnapshot: {
        metadataEpoch: METADATA_EPOCH,
        revision: 1n,
        snapshotId: new Uint8Array(16).fill(1),
        chunkIndex: 0,
        totalChunks: 2,
        records: records.slice(0, 3),
      },
    });
    client.handleEvent({
      SourceMetadataSnapshot: {
        metadataEpoch: METADATA_EPOCH,
        revision: 2n,
        snapshotId: new Uint8Array(16).fill(2),
        chunkIndex: 0,
        totalChunks: 1,
        records,
      },
    });
    events.length = 0;

    client.handleEvent({
      SourceMetadataSnapshot: {
        metadataEpoch: METADATA_EPOCH,
        revision: 1n,
        snapshotId: new Uint8Array(16).fill(1),
        chunkIndex: 1,
        totalChunks: 2,
        records: records.slice(3),
      },
    });

    expect(events.filter((event) => event.type === 'metadata-snapshot')).toEqual([]);
  });

  test('按 canonical TREE_ORDER 字段重排设备树', () => {
    const { client, events } = createHarness();
    const records = metadataRecords();
    const session = key(wsBorsh.SOURCE_ENTITY_SESSION, '$1');
    const secondWindow = key(wsBorsh.SOURCE_ENTITY_WINDOW, '@2');
    records
      .find((record) => record.key.entityKind === wsBorsh.SOURCE_ENTITY_WINDOW)
      ?.fields.push({ field: wsBorsh.SOURCE_FIELD_TREE_ORDER, value: { U32: 1 } });
    records.push(
      {
        key: secondWindow,
        parent: session,
        fields: [
          { field: wsBorsh.SOURCE_FIELD_NAME, value: { String: 'second' } },
          { field: wsBorsh.SOURCE_FIELD_INDEX, value: { U32: 1 } },
          { field: wsBorsh.SOURCE_FIELD_TREE_ORDER, value: { U32: 0 } },
        ],
      },
      {
        key: key(wsBorsh.SOURCE_ENTITY_PANE, '%2'),
        parent: secondWindow,
        fields: [
          { field: wsBorsh.SOURCE_FIELD_INDEX, value: { U32: 0 } },
          { field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Bytes16: PANE_EPOCH } },
        ],
      }
    );
    client.activate();
    client.handleEvent({
      SourceMetadataSnapshot: {
        metadataEpoch: METADATA_EPOCH,
        revision: 1n,
        snapshotId: REQUEST_ID,
        chunkIndex: 0,
        totalChunks: 1,
        records,
      },
    });

    const snapshot = events.find((event) => event.type === 'metadata-snapshot');
    expect(
      snapshot?.type === 'metadata-snapshot' && snapshot.snapshot.session?.windows.map((w) => w.id)
    ).toEqual(['@2', '@1']);
  });

  test('metadata patch 下发的整棵快照已按最新 TREE_ORDER 排好', () => {
    const { client, events } = createHarness();
    const records = metadataRecords();
    const session = key(wsBorsh.SOURCE_ENTITY_SESSION, '$1');
    const secondWindow = key(wsBorsh.SOURCE_ENTITY_WINDOW, '@2');
    records.push(
      {
        key: secondWindow,
        parent: session,
        fields: [
          { field: wsBorsh.SOURCE_FIELD_NAME, value: { String: 'second' } },
          { field: wsBorsh.SOURCE_FIELD_INDEX, value: { U32: 1 } },
        ],
      },
      {
        key: key(wsBorsh.SOURCE_ENTITY_PANE, '%2'),
        parent: secondWindow,
        fields: [
          { field: wsBorsh.SOURCE_FIELD_INDEX, value: { U32: 0 } },
          { field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Bytes16: PANE_EPOCH } },
        ],
      }
    );
    client.activate();
    client.handleEvent({
      SourceMetadataSnapshot: {
        metadataEpoch: METADATA_EPOCH,
        revision: 1n,
        snapshotId: REQUEST_ID,
        chunkIndex: 0,
        totalChunks: 1,
        records,
      },
    });
    events.length = 0;

    client.handleEvent({
      SourceMetadataPatch: {
        metadataEpoch: METADATA_EPOCH,
        fromRevision: 1n,
        throughRevision: 2n,
        upserts: [
          {
            key: key(wsBorsh.SOURCE_ENTITY_WINDOW, '@1'),
            parent: null,
            fields: [{ field: wsBorsh.SOURCE_FIELD_TREE_ORDER, value: { U32: 1 } }],
          },
          {
            key: secondWindow,
            parent: null,
            fields: [{ field: wsBorsh.SOURCE_FIELD_TREE_ORDER, value: { U32: 0 } }],
          },
        ],
        removals: [],
      },
    });

    const patch = events.find((event) => event.type === 'metadata-patch');
    expect(
      patch?.type === 'metadata-patch' && patch.snapshot.session?.windows.map((w) => w.id)
    ).toEqual(['@2', '@1']);
  });

  test('自定义名随 canonical CUSTOM_NAME 字段增删', () => {
    const { client, events } = createHarness();
    client.activate();
    const namedRecords = metadataRecords();
    namedRecords
      .find((record) => record.key.entityKind === wsBorsh.SOURCE_ENTITY_WINDOW)
      ?.fields.push({ field: wsBorsh.SOURCE_FIELD_CUSTOM_NAME, value: { String: 'My Window' } });
    namedRecords
      .find((record) => record.key.entityKind === wsBorsh.SOURCE_ENTITY_PANE)
      ?.fields.push({ field: wsBorsh.SOURCE_FIELD_CUSTOM_NAME, value: { String: 'My Pane' } });
    client.handleEvent({
      SourceMetadataSnapshot: {
        metadataEpoch: METADATA_EPOCH,
        revision: 1n,
        snapshotId: REQUEST_ID,
        chunkIndex: 0,
        totalChunks: 1,
        records: namedRecords,
      },
    });
    const seeded = events.filter((event) => event.type === 'metadata-snapshot').at(-1);
    expect(
      seeded?.type === 'metadata-snapshot' && seeded.snapshot.session?.windows[0]
    ).toMatchObject({
      customName: 'My Window',
      panes: [{ customName: 'My Pane' }],
    });

    client.handleEvent({
      SourceMetadataPatch: {
        metadataEpoch: METADATA_EPOCH,
        fromRevision: 1n,
        throughRevision: 2n,
        upserts: [
          {
            key: key(wsBorsh.SOURCE_ENTITY_WINDOW, '@1'),
            parent: null,
            fields: [{ field: wsBorsh.SOURCE_FIELD_CUSTOM_NAME, value: { Unset: {} } }],
          },
          {
            key: key(wsBorsh.SOURCE_ENTITY_PANE, '%1'),
            parent: key(wsBorsh.SOURCE_ENTITY_WINDOW, '@1'),
            fields: [{ field: wsBorsh.SOURCE_FIELD_CUSTOM_NAME, value: { Unset: {} } }],
          },
        ],
        removals: [],
      },
    });
    const patched = events.filter((event) => event.type === 'metadata-patch').at(-1);
    const window = patched?.type === 'metadata-patch' ? patched.snapshot.session?.windows[0] : null;
    expect(window?.customName).toBeUndefined();
    expect(window?.panes[0]?.customName).toBeUndefined();
  });

  test('resize 自增 sizeEpoch，sync 复用同一 epoch 并标记 resend', () => {
    const { client, messages } = createHarness();
    client.activate();
    installMetadata(client);

    const send = (type: 'terminal-resize' | 'terminal-sync-size', cols: number) =>
      client.sendCommand({ type, deviceId: 'device-a', paneId: '%1', cols, rows: 24 });

    send('terminal-sync-size', 80);
    const first = decode(messages.at(-1) as EncodedGatewayCommand);
    if (!('ResizePaneV11' in first)) throw new Error('missing resize');
    // 该 pane 还没有过真实尺寸变化：补发用保留值以外的最小 epoch
    expect(first.ResizePaneV11).toMatchObject({
      geometryReason: wsBorsh.CANONICAL_GEOMETRY_REASON_RESEND,
      sizeEpoch: 1n,
    });

    send('terminal-resize', 100);
    const change = decode(messages.at(-1) as EncodedGatewayCommand);
    if (!('ResizePaneV11' in change)) throw new Error('missing resize');
    expect(change.ResizePaneV11).toMatchObject({
      geometryReason: wsBorsh.CANONICAL_GEOMETRY_REASON_CHANGE,
      sizeEpoch: 1n,
    });

    send('terminal-sync-size', 100);
    const resend = decode(messages.at(-1) as EncodedGatewayCommand);
    if (!('ResizePaneV11' in resend)) throw new Error('missing resize');
    expect(resend.ResizePaneV11).toMatchObject({
      geometryReason: wsBorsh.CANONICAL_GEOMETRY_REASON_RESEND,
      sizeEpoch: 1n,
    });

    send('terminal-resize', 120);
    const next = decode(messages.at(-1) as EncodedGatewayCommand);
    if (!('ResizePaneV11' in next)) throw new Error('missing resize');
    expect(next.ResizePaneV11.sizeEpoch).toBe(2n);
  });

  test('ignores an unsolicited content transaction', () => {
    const { client, events } = createHarness();
    client.activate();
    installMetadata(client);
    events.length = 0;
    client.handleEvent({
      ScreenBegin: {
        requestId: REQUEST_ID,
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
        paneEpoch: PANE_EPOCH,
        baseSeq: 0n,
        rows: 24,
        cols: 80,
        modes: 0,
        totalBytes: 1,
      },
    });
    client.handleEvent({
      ScreenChunk: { requestId: REQUEST_ID, offset: 0, data: new Uint8Array([1]) },
    });
    client.handleEvent({
      ScreenCommit: { requestId: REQUEST_ID, totalBytes: 1, historyCursor: null },
    });

    expect(events).toEqual([]);
  });

  test('rejects a screen transaction committed after its pane epoch changed', () => {
    const { client, events } = createHarness();
    const nextPaneEpoch = new Uint8Array(16).fill(0x23);
    client.activate();
    installMetadata(client);
    client.sendCommand({
      type: 'request-pane-screen',
      requestId: REQUEST_ID,
      deviceId: 'device-a',
      paneId: '%1',
      byteLimit: 4_096,
    });
    client.handleEvent({
      ScreenBegin: {
        requestId: REQUEST_ID,
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
        paneEpoch: PANE_EPOCH,
        baseSeq: 0n,
        rows: 24,
        cols: 80,
        modes: 0,
        totalBytes: 1,
      },
    });
    client.handleEvent({
      ScreenChunk: { requestId: REQUEST_ID, offset: 0, data: new Uint8Array([1]) },
    });
    client.handleEvent({
      SourceMetadataPatch: {
        metadataEpoch: METADATA_EPOCH,
        fromRevision: 1n,
        throughRevision: 2n,
        upserts: [
          {
            key: key(wsBorsh.SOURCE_ENTITY_PANE, '%1'),
            parent: key(wsBorsh.SOURCE_ENTITY_WINDOW, '@1'),
            fields: [{ field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Bytes16: nextPaneEpoch } }],
          },
        ],
        removals: [],
      },
    });
    events.length = 0;
    client.handleEvent({
      ScreenCommit: { requestId: REQUEST_ID, totalBytes: 1, historyCursor: null },
    });

    expect(events).toEqual([
      {
        type: 'rebase-required',
        deviceId: 'device-a',
        paneId: '%1',
        reason: 'epoch_changed',
      },
    ]);
  });

  test('never applies pane data before metadata or after pane removal', () => {
    const { client, events } = createHarness();
    const paneData: wsBorsh.CanonicalEvent = {
      PaneData: {
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
        paneEpoch: PANE_EPOCH,
        seqStart: 0n,
        seqEnd: 1n,
        data: new Uint8Array([1]),
      },
    };
    client.activate();
    client.handleEvent(paneData);
    expect(events).toEqual([{ type: 'rebase-required', reason: 'metadata_gap' }]);

    installMetadata(client);
    client.handleEvent({
      SourceMetadataPatch: {
        metadataEpoch: METADATA_EPOCH,
        fromRevision: 1n,
        throughRevision: 2n,
        upserts: [],
        removals: [key(wsBorsh.SOURCE_ENTITY_PANE, '%1')],
      },
    });
    events.length = 0;
    client.handleEvent(paneData);

    expect(events).toEqual([{ type: 'rebase-required', reason: 'metadata_gap' }]);
  });

  test('force-resubscribes from the retained cursor after metadata recovery drops pane data', () => {
    const { client, messages, events } = createHarness();
    client.activate();
    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    installMetadata(client);
    client.handleEvent({
      PaneData: {
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
        paneEpoch: PANE_EPOCH,
        seqStart: 0n,
        seqEnd: 1n,
        data: new Uint8Array([1]),
      },
    });
    client.handleEvent({
      SourceMetadataPatch: {
        metadataEpoch: METADATA_EPOCH,
        fromRevision: 2n,
        throughRevision: 3n,
        upserts: [metadataRecords().at(-1) as wsBorsh.SourceMetadataRecord],
        removals: [],
      },
    });
    const beforeRecovery = messages.length;
    events.length = 0;

    client.handleEvent({
      PaneData: {
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
        paneEpoch: PANE_EPOCH,
        seqStart: 1n,
        seqEnd: 2n,
        data: new Uint8Array([2]),
      },
    });
    installMetadata(client, 3n);

    expect(events.some((event) => event.type === 'terminal-data')).toBe(false);
    expect(messages).toHaveLength(beforeRecovery + 1);
    const subscription = decode(messages.at(-1) as EncodedGatewayCommand);
    if (!('SetPaneSubscriptions' in subscription)) {
      throw new Error('missing recovery subscription');
    }
    expect(subscription.SetPaneSubscriptions.activePanes[0]?.cursor).toEqual({
      paneEpoch: PANE_EPOCH,
      terminalSeq: 1n,
    });
    client.dispose();
  });

  test('requests a connection-level metadata recovery when no snapshot resolves a gap', async () => {
    let recoveries = 0;
    const client = new CanonicalStateClient({
      emit: () => {},
      send: () => 'sent',
      effectiveMaxFrameBytes: () => 32 * 1024,
      onMetadataGap: () => {
        recoveries += 1;
      },
      metadataRecoveryDelayMs: 0,
    });
    client.activate();
    client.handleEvent({
      PaneData: {
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
        paneEpoch: PANE_EPOCH,
        seqStart: 0n,
        seqEnd: 1n,
        data: new Uint8Array([1]),
      },
    });
    await Bun.sleep(5);

    expect(recoveries).toBe(1);
    client.dispose();
  });

  test('does not let one device snapshot cancel another device metadata recovery', async () => {
    let recoveries = 0;
    const client = new CanonicalStateClient({
      emit: () => {},
      send: () => 'sent',
      effectiveMaxFrameBytes: () => 32 * 1024,
      onMetadataGap: () => {
        recoveries += 1;
      },
      metadataRecoveryDelayMs: 0,
    });
    const secondServerEpoch = new Uint8Array(16).fill(0x77);
    const snapshot = (snapshotId: number, records: wsBorsh.SourceMetadataRecord[], revision = 1n) =>
      client.handleEvent({
        SourceMetadataSnapshot: {
          metadataEpoch: METADATA_EPOCH,
          revision,
          snapshotId: new Uint8Array(16).fill(snapshotId),
          chunkIndex: 0,
          totalChunks: 1,
          records,
        },
      });

    client.activate();
    snapshot(1, metadataRecords());
    snapshot(2, metadataRecordsForDevice('device-b', secondServerEpoch));
    client.handleEvent({
      SourceMetadataPatch: {
        metadataEpoch: METADATA_EPOCH,
        fromRevision: 2n,
        throughRevision: 3n,
        upserts: [
          {
            key: {
              deviceId: 'device-b',
              serverEpoch: secondServerEpoch,
              entityKind: wsBorsh.SOURCE_ENTITY_PANE,
              nativeId: '%1',
            },
            parent: null,
            fields: [],
          },
        ],
        removals: [],
      },
    });
    snapshot(3, metadataRecords(), 2n);
    await Bun.sleep(5);

    expect(recoveries).toBe(1);
    client.dispose();
  });

  test('applies contiguous metadata patches and surfaces a revision gap without partial state', () => {
    const { client, events } = createHarness();
    client.activate();
    installMetadata(client);
    events.length = 0;
    const pane = key(wsBorsh.SOURCE_ENTITY_PANE, '%1');
    const window = key(wsBorsh.SOURCE_ENTITY_WINDOW, '@1');
    client.handleEvent({
      SourceMetadataPatch: {
        metadataEpoch: METADATA_EPOCH,
        fromRevision: 1n,
        throughRevision: 2n,
        upserts: [
          {
            key: pane,
            parent: window,
            fields: [{ field: wsBorsh.SOURCE_FIELD_TITLE, value: { String: 'editor' } }],
          },
        ],
        removals: [],
      },
    });
    expect(events.filter((event) => event.type === 'metadata-patch')).toHaveLength(1);

    client.handleEvent({
      SourceMetadataPatch: {
        metadataEpoch: METADATA_EPOCH,
        fromRevision: 3n,
        throughRevision: 4n,
        upserts: [],
        removals: [pane],
      },
    });
    expect(events.at(-1)).toEqual({ type: 'rebase-required', reason: 'metadata_gap' });
    expect(events.filter((event) => event.type === 'metadata-patch')).toHaveLength(1);
  });

  test('preserves every subscription rejection reason and never drops an unknown gap reason', () => {
    const { client, events } = createHarness();
    client.activate();
    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    installMetadata(client);
    events.length = 0;
    client.handleEvent({
      SubscriptionApplied: {
        generation: 3n,
        activePanes: [],
        hotPanes: [],
        rejected: [
          {
            pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%missing' },
            reason: wsBorsh.SUBSCRIPTION_REJECTED_NOT_FOUND,
          },
          {
            pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%busy' },
            reason: wsBorsh.SUBSCRIPTION_REJECTED_RESOURCE_EXHAUSTED,
          },
          {
            pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
            reason: wsBorsh.SUBSCRIPTION_REJECTED_EPOCH_CHANGED,
          },
        ],
      },
    });
    const applied = events.find((event) => event.type === 'subscription-applied');
    expect(applied?.type === 'subscription-applied' && applied.rejections).toEqual([
      { deviceId: 'device-a', paneId: '%missing', reason: 'not_found' },
      { deviceId: 'device-a', paneId: '%busy', reason: 'resource_exhausted' },
      { deviceId: 'device-a', paneId: '%1', reason: 'epoch_changed' },
    ]);

    client.handleEvent({
      SourceGap: {
        reason: 255,
        scope: {
          Pane: {
            pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
            expectedPaneEpoch: PANE_EPOCH,
            availablePaneEpoch: PANE_EPOCH,
            expectedSeq: 1n,
            availableSeq: 2n,
          },
        },
      },
    });
    expect(events.at(-1)).toEqual({
      type: 'rebase-required',
      deviceId: 'device-a',
      paneId: '%1',
      reason: 'pane_gap',
    });
  });

  test('drops queued input after an explicit not-found rejection', () => {
    const { client, messages } = createHarness();
    client.activate();
    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    client.sendCommand({
      type: 'terminal-input',
      deviceId: 'device-a',
      paneId: '%1',
      data: 'stale',
      isComposing: false,
    });
    client.handleEvent({
      SubscriptionApplied: {
        generation: 2n,
        activePanes: [],
        hotPanes: [],
        rejected: [
          {
            pane: { deviceId: 'device-a', serverEpoch: new Uint8Array(16), paneId: '%1' },
            reason: wsBorsh.SUBSCRIPTION_REJECTED_NOT_FOUND,
          },
        ],
      },
    });

    installMetadata(client);

    expect(messages.map(decode).some((command) => 'TerminalInput' in command)).toBe(false);
  });

  test('backs off epoch-changed retries and waits for fresh metadata after exhaustion', async () => {
    let recoveries = 0;
    const { client, messages } = createHarness(32 * 1024, 1, {
      subscriptionRetryMaxAttempts: 2,
      metadataRecoveryDelayMs: 0,
      onMetadataGap: () => {
        recoveries += 1;
      },
    });
    client.activate();
    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    installMetadata(client);
    client.handleEvent({
      PaneData: {
        pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
        paneEpoch: PANE_EPOCH,
        seqStart: 0n,
        seqEnd: 1n,
        data: new Uint8Array([1]),
      },
    });
    const rejectLatest = () => {
      const subscription = decode(messages.at(-1) as EncodedGatewayCommand);
      if (!('SetPaneSubscriptions' in subscription)) throw new Error('missing subscription');
      client.handleEvent({
        SubscriptionApplied: {
          generation: subscription.SetPaneSubscriptions.generation,
          activePanes: [],
          hotPanes: [],
          rejected: [
            {
              pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
              reason: wsBorsh.SUBSCRIPTION_REJECTED_EPOCH_CHANGED,
            },
          ],
        },
      });
    };

    let beforeRetry = messages.length;
    rejectLatest();
    expect(messages).toHaveLength(beforeRetry);
    await Bun.sleep(5);
    expect(messages).toHaveLength(beforeRetry + 1);
    let retried = decode(messages.at(-1) as EncodedGatewayCommand);
    if (!('SetPaneSubscriptions' in retried)) throw new Error('missing subscription retry');
    expect(retried.SetPaneSubscriptions.activePanes[0]?.cursor).toBeNull();

    beforeRetry = messages.length;
    rejectLatest();
    await Bun.sleep(5);
    expect(messages).toHaveLength(beforeRetry + 1);

    beforeRetry = messages.length;
    rejectLatest();
    await Bun.sleep(5);
    expect(messages).toHaveLength(beforeRetry);
    expect(recoveries).toBe(1);

    const nextServerEpoch = new Uint8Array(16).fill(0x77);
    client.handleEvent({
      SourceMetadataSnapshot: {
        metadataEpoch: METADATA_EPOCH,
        revision: 2n,
        snapshotId: new Uint8Array(16).fill(0x78),
        chunkIndex: 0,
        totalChunks: 1,
        records: metadataRecordsForDevice('device-a', nextServerEpoch),
      },
    });
    retried = decode(messages.at(-1) as EncodedGatewayCommand);
    if (!('SetPaneSubscriptions' in retried)) throw new Error('missing recovered subscription');
    expect(retried.SetPaneSubscriptions.activePanes[0]?.pane.serverEpoch).toEqual(nextServerEpoch);
    client.dispose();
  });

  test('stops permanent resource-exhausted retries until a recovery condition occurs', async () => {
    const { client, messages } = createHarness(32 * 1024, 0, {
      subscriptionRetryMaxAttempts: 1,
    });
    client.activate();
    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    installMetadata(client);
    const rejectLatest = () => {
      const subscription = decode(messages.at(-1) as EncodedGatewayCommand);
      if (!('SetPaneSubscriptions' in subscription)) throw new Error('missing subscription');
      client.handleEvent({
        SubscriptionApplied: {
          generation: subscription.SetPaneSubscriptions.generation,
          activePanes: [],
          hotPanes: [],
          rejected: [
            {
              pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
              reason: wsBorsh.SUBSCRIPTION_REJECTED_RESOURCE_EXHAUSTED,
            },
          ],
        },
      });
    };

    rejectLatest();
    await Bun.sleep(5);
    rejectLatest();
    const stableCount = messages.length;
    await Bun.sleep(10);
    expect(messages).toHaveLength(stableCount);

    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 2n,
      paneIds: ['%1', '%2'],
    });
    rejectLatest();
    await Bun.sleep(5);
    expect(messages.length).toBe(stableCount + 2);

    rejectLatest();
    const exhaustedAgain = messages.length;
    expect(client.resumeSubscriptions()).toBe('sent');
    expect(messages).toHaveLength(exhaustedAgain + 1);

    client.suspend();
    client.activate();
    expect(messages).toHaveLength(exhaustedAgain + 2);
    client.dispose();
  });

  test('retries a resource-exhausted subscription with a higher generation', async () => {
    const { client, messages } = createHarness(32 * 1024, 0);
    client.activate();
    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    installMetadata(client);
    client.handleEvent({
      SubscriptionApplied: {
        generation: 3n,
        activePanes: [],
        hotPanes: [],
        rejected: [
          {
            pane: { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' },
            reason: wsBorsh.SUBSCRIPTION_REJECTED_RESOURCE_EXHAUSTED,
          },
        ],
      },
    });
    await Bun.sleep(5);

    const retried = decode(messages.at(-1) as EncodedGatewayCommand);
    if (!('SetPaneSubscriptions' in retried)) throw new Error('missing subscription retry');
    expect(retried.SetPaneSubscriptions.generation).toBe(4n);
    client.handleEvent({
      SubscriptionApplied: {
        generation: 4n,
        activePanes: [{ deviceId: 'device-a', serverEpoch: SERVER_EPOCH, paneId: '%1' }],
        hotPanes: [],
        rejected: [],
      },
    });
    client.dispose();
  });
});

describe('CanonicalStateClient PaneData payload fast path', () => {
  const eventFor = (
    data: Uint8Array,
    seqStart: bigint,
    serverEpoch = SERVER_EPOCH,
    paneEpoch = PANE_EPOCH
  ): Extract<wsBorsh.CanonicalEvent, { PaneData: unknown }> => ({
    PaneData: {
      pane: { deviceId: 'device-a', serverEpoch, paneId: '%1' },
      paneEpoch,
      seqStart,
      seqEnd: seqStart + BigInt(data.byteLength),
      data,
    },
  });

  test('owns delivered bytes before the source payload can be reused', () => {
    const { client, events } = createHarness();
    installMetadata(client);
    events.length = 0;
    const payload = wsBorsh.encodeCanonicalEventPayload(
      eventFor(new TextEncoder().encode('stable-output'), 0n)
    );

    client.handleEventPayload(payload);
    const output = events.at(-1);
    if (!output || output.type !== 'terminal-data') throw new Error('missing terminal data');
    expect(output.frame.data.buffer).not.toBe(payload.buffer);
    payload.fill(0xee);
    expect(new TextDecoder().decode(output.frame.data)).toBe('stable-output');
    client.dispose();
  });

  test('matches full decoding across random sequence gaps and epoch edges', () => {
    let state = 0xa341_316c;
    const next = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };
    const bytes = (length: number) => Uint8Array.from({ length }, () => next() & 0xff);

    for (let index = 0; index < 96; index += 1) {
      const fast = createHarness();
      const slow = createHarness();
      installMetadata(fast.client);
      installMetadata(slow.client);
      const baseStart = BigInt(next() % 10_000);
      const baseLength = 1 + (next() % 32);
      const baseEvent = eventFor(bytes(baseLength), baseStart);
      fast.client.handleEventPayload(wsBorsh.encodeCanonicalEventPayload(baseEvent));
      slow.client.handleEvent(baseEvent);
      fast.events.length = 0;
      slow.events.length = 0;
      fast.messages.length = 0;
      slow.messages.length = 0;

      const baseEnd = baseStart + BigInt(baseLength);
      const mode = index % 7;
      let data = bytes(1 + (next() % 64));
      let seqStart = baseEnd;
      let serverEpoch = SERVER_EPOCH;
      let paneEpoch = PANE_EPOCH;
      if (mode === 1) {
        const overlap = 1 + (next() % baseLength);
        seqStart = baseEnd - BigInt(overlap);
        data = bytes(overlap + 1 + (next() % 16));
      } else if (mode === 2) {
        data = bytes(1 + (next() % baseLength));
        seqStart = baseStart;
      } else if (mode === 3) {
        seqStart = baseEnd + 1n;
      } else if (mode === 4) {
        serverEpoch = new Uint8Array(16).fill(0x91);
      } else if (mode === 5) {
        paneEpoch = new Uint8Array(16).fill(0x92);
      } else if (mode === 6) {
        data = new Uint8Array();
      }

      const event = eventFor(data, seqStart, serverEpoch, paneEpoch);
      const payload = wsBorsh.encodeCanonicalEventPayload(event);
      const decoded = wsBorsh.decodeCanonicalEventPayload(payload).event;
      slow.client.handleEvent(decoded);
      fast.client.handleEventPayload(payload);
      payload.fill(0xee);

      expect(fast.events).toEqual(slow.events);
      expect(fast.messages).toEqual(slow.messages);
      fast.client.dispose();
      slow.client.dispose();
    }
  });
});
