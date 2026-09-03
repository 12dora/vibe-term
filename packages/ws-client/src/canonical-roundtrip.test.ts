import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import type { PaneHistoryCursor } from '../../../apps/gateway/src/tmux-client/pane-history-reader';
import { PaneRetention } from '../../../apps/gateway/src/tmux-client/pane-retention';
import {
  type CanonicalFeedRuntime,
  CanonicalFeedSession,
} from '../../../apps/gateway/src/ws/canonical-feed-session';
import { CanonicalStateClient } from './canonical-state-client';
import type { GatewayTransportEvent } from './transport-types';

const SERVER_EPOCH = new Uint8Array(16).fill(0x10);
const METADATA_EPOCH = new Uint8Array(16).fill(0x20);
const HISTORY_EPOCH = new Uint8Array(16).fill(0x30);
const FIRST_PANE_EPOCH = new Uint8Array(16).fill(0x40);
const SECOND_PANE_EPOCH = new Uint8Array(16).fill(0x41);
const SCREEN_REQUEST = new Uint8Array(16).fill(0x50);
const HISTORY_REQUEST = new Uint8Array(16).fill(0x60);

function sourceKey(entityKind: number, nativeId: string): wsBorsh.SourceEntityKey {
  return { deviceId: 'device-a', serverEpoch: SERVER_EPOCH, entityKind, nativeId };
}

class RoundTripRuntime implements CanonicalFeedRuntime {
  readonly retention = new PaneRetention({ scheduleTimers: false });
  readonly inputs: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  paneEpoch = FIRST_PANE_EPOCH;
  screen = 'base';

  constructor() {
    this.retention.reconcilePanes([{ paneId: '%1', paneEpoch: this.paneEpoch }]);
  }

  getServerEpoch(): Uint8Array {
    return SERVER_EPOCH;
  }

  getPaneIdentity(paneId: string) {
    return paneId === '%1' ? { paneId, paneEpoch: this.paneEpoch } : null;
  }

  getMetadataSnapshot() {
    const device = sourceKey(wsBorsh.SOURCE_ENTITY_DEVICE, 'device-a');
    const server = sourceKey(wsBorsh.SOURCE_ENTITY_SERVER, 'server');
    const session = sourceKey(wsBorsh.SOURCE_ENTITY_SESSION, '$1');
    const window = sourceKey(wsBorsh.SOURCE_ENTITY_WINDOW, '@1');
    const pane = sourceKey(wsBorsh.SOURCE_ENTITY_PANE, '%1');
    return {
      metadataEpoch: METADATA_EPOCH,
      revision: 1n,
      records: [
        { key: device, parent: null, fields: [] },
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
            { field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Bytes16: this.paneEpoch } },
          ],
        },
      ],
    };
  }

  attachPaneConsumer(callbacks: Parameters<PaneRetention['attachConsumer']>[0]) {
    return this.retention.attachConsumer(callbacks);
  }

  subscribe(): () => void {
    return () => {};
  }

  async readPaneHistory(paneId: string, cursor: PaneHistoryCursor | null, byteLimit: number) {
    if (paneId !== '%1') return null;
    expect(byteLimit).toBeGreaterThan(0);
    expect(cursor?.beforeLine).toBe(100);
    return {
      paneId,
      paneEpoch: this.paneEpoch,
      historyEpoch: HISTORY_EPOCH,
      lineStart: 90,
      lineEnd: 100,
      truncated: false,
      data: new TextEncoder().encode('history'),
      nextCursor: {
        paneEpoch: this.paneEpoch,
        historyEpoch: HISTORY_EPOCH,
        beforeLine: 90,
      },
    };
  }

  async captureCanonicalScreen(paneId: string) {
    if (paneId !== '%1') return null;
    const cursor = this.retention.getLatestCursor(paneId);
    if (!cursor) return null;
    return {
      paneId,
      paneEpoch: this.paneEpoch,
      baseSeq: cursor.terminalSeq,
      rows: 24,
      cols: 80,
      modes: 0,
      data: new TextEncoder().encode(this.screen),
      historyCursor: {
        paneEpoch: this.paneEpoch,
        historyEpoch: HISTORY_EPOCH,
        beforeLine: 100,
      },
      capturedAt: Date.now(),
    };
  }

  sendInputBytes(_paneId: string, data: Uint8Array): void {
    this.inputs.push(new TextDecoder().decode(data));
  }

  resizePane(_paneId: string, cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }

  output(value: string): void {
    this.retention.ingest('%1', this.paneEpoch, new TextEncoder().encode(value));
  }

  rotatePaneEpoch(): void {
    this.paneEpoch = SECOND_PANE_EPOCH;
    this.screen = 'rebased';
    this.retention.reconcilePanes([{ paneId: '%1', paneEpoch: this.paneEpoch }]);
  }
}

async function settle(tasks: Promise<void>[]): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    const pending = tasks.splice(0);
    if (pending.length === 0) {
      await Bun.sleep(0);
      if (tasks.length === 0) return;
      continue;
    }
    await Promise.all(pending);
    await Bun.sleep(0);
  }
  throw new Error('canonical round trip did not settle');
}

describe('canonical client to server round trip', () => {
  test('keeps one ordered stream through replay, commands, transactions, gap and re-sync', async () => {
    const runtime = new RoundTripRuntime();
    const events: GatewayTransportEvent[] = [];
    const tasks: Promise<void>[] = [];
    let id = 0;
    let seq = 0;
    const client = new CanonicalStateClient({
      emit: (event) => events.push(event),
      effectiveMaxFrameBytes: () => 32 * 1024,
      createId: () => new Uint8Array(16).fill(++id),
      send: (message) => {
        const frame = wsBorsh.encodeEnvelope(message.kind, message.payload, ++seq);
        const envelope = wsBorsh.decodeEnvelope(frame);
        expect(envelope.kind).toBe(wsBorsh.KIND_CANONICAL_COMMAND);
        const command = wsBorsh.decodeCanonicalCommandPayload(envelope.payload).command;
        tasks.push(server.handleCommand(command));
        return 'sent';
      },
    });
    const server = new CanonicalFeedSession({
      maxFrameBytes: 32 * 1024,
      resolveRuntime: async () => runtime,
      sendEvent: (event) => {
        const payload = wsBorsh.encodeCanonicalEventPayload(event);
        const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_CANONICAL_EVENT, payload, ++seq);
        const envelope = wsBorsh.decodeEnvelope(frame);
        expect(envelope.kind).toBe(wsBorsh.KIND_CANONICAL_EVENT);
        client.handleEventPayload(envelope.payload);
        return true;
      },
    });

    client.activate();
    client.sendCommand({
      type: 'set-pane-subscriptions',
      deviceId: 'device-a',
      generation: 1n,
      paneIds: ['%1'],
    });
    await settle(tasks);
    expect(events.some((event) => event.type === 'metadata-snapshot')).toBe(true);
    expect(events.some((event) => event.type === 'subscription-applied')).toBe(true);

    client.sendCommand({
      type: 'request-pane-screen',
      requestId: SCREEN_REQUEST,
      deviceId: 'device-a',
      paneId: '%1',
      byteLimit: 4096,
    });
    await settle(tasks);
    const firstScreen = events.find((event) => event.type === 'screen-snapshot');
    expect(
      firstScreen?.type === 'screen-snapshot' && new TextDecoder().decode(firstScreen.snapshot.data)
    ).toBe('base');

    runtime.output('live');
    await Bun.sleep(20);
    const live = events.find(
      (event) =>
        event.type === 'terminal-data' && new TextDecoder().decode(event.frame.data) === 'live'
    );
    expect(live?.type === 'terminal-data' && live.frame.seqStart).toBe(0n);

    client.sendCommand({
      type: 'terminal-input',
      deviceId: 'device-a',
      paneId: '%1',
      data: 'x',
      isComposing: false,
    });
    client.sendCommand({
      type: 'terminal-resize',
      deviceId: 'device-a',
      paneId: '%1',
      cols: 100,
      rows: 30,
    });
    await settle(tasks);
    expect(runtime.inputs).toEqual(['x']);
    expect(runtime.sizes).toEqual([[100, 30]]);

    client.sendCommand({
      type: 'request-pane-history',
      requestId: HISTORY_REQUEST,
      deviceId: 'device-a',
      paneId: '%1',
      cursor: {
        paneEpoch: FIRST_PANE_EPOCH,
        historyEpoch: HISTORY_EPOCH,
        beforeLine: 100,
      },
      byteLimit: 4096,
    });
    await settle(tasks);
    const history = events.find((event) => event.type === 'history-page');
    expect(history?.type === 'history-page' && new TextDecoder().decode(history.page.data)).toBe(
      'history'
    );
    expect(history?.type === 'history-page' && history.page.nextCursor?.beforeLine).toBe(90);

    runtime.rotatePaneEpoch();
    await settle(tasks);
    expect(
      events.some((event) => event.type === 'rebase-required' && event.reason === 'epoch_changed')
    ).toBe(true);

    const rebaseRequest = new Uint8Array(16).fill(0x70);
    client.sendCommand({
      type: 'request-pane-screen',
      requestId: rebaseRequest,
      deviceId: 'device-a',
      paneId: '%1',
      byteLimit: 4096,
    });
    await settle(tasks);
    const screens = events.filter((event) => event.type === 'screen-snapshot');
    const rebased = screens.at(-1);
    expect(
      rebased?.type === 'screen-snapshot' && new TextDecoder().decode(rebased.snapshot.data)
    ).toBe('rebased');
    expect(rebased?.type === 'screen-snapshot' && rebased.snapshot.paneEpoch).toEqual(
      SECOND_PANE_EPOCH
    );

    server.close();
    client.dispose();
  });
});
