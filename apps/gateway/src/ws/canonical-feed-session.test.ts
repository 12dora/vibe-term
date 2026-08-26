import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';

import type { DeviceSessionRuntimeListener } from '../tmux-client/device-session-runtime';
import type { PaneHistoryCursor } from '../tmux-client/pane-history-reader';
import {
  PaneRetention,
  type PaneRetentionConsumerCallbacks,
  type PaneScreenCheckpoint,
  type PaneTerminalCursor,
} from '../tmux-client/pane-retention';
import {
  CANONICAL_MAX_SCREEN_BYTES,
  CANONICAL_PENDING_SWEEP_MS,
  type CanonicalFeedRuntime,
  CanonicalFeedSession,
} from './canonical-feed-session';
import type { CanonicalSendResult } from './canonical/types';
import { GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS } from './terminal-output-batcher';
import { WebSocketSendGuard } from './websocket-send-guard';

const awaitPaneDataFlush = () => Bun.sleep(GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS + 4);

const SERVER_EPOCH = new Uint8Array(16).fill(0x11);
const PANE_EPOCH = new Uint8Array(16).fill(0x22);
const REQUEST_ID = new Uint8Array(16).fill(0x33);
const encoder = new TextEncoder();

class FakeRuntime implements CanonicalFeedRuntime {
  readonly retention = new PaneRetention({ scheduleTimers: false });
  readonly listeners = new Set<DeviceSessionRuntimeListener>();
  readonly input: Array<[string, string]> = [];
  readonly resizes: Array<[string, number, number]> = [];
  screenData = encoder.encode('screen');
  checkpoint: PaneScreenCheckpoint | null = null;
  baseSeqOverride: bigint | null = null;

  constructor(readonly deviceId = 'device-a') {
    this.retention.reconcilePanes([{ paneId: '%1', paneEpoch: PANE_EPOCH }]);
  }

  getServerEpoch(): Uint8Array {
    return SERVER_EPOCH;
  }

  getMetadataSnapshot() {
    return {
      metadataEpoch: new Uint8Array(16).fill(0x44),
      revision: 1n,
      records: [
        {
          key: {
            deviceId: this.deviceId,
            serverEpoch: SERVER_EPOCH,
            entityKind: wsBorsh.SOURCE_ENTITY_PANE,
            nativeId: '%1',
          },
          parent: null,
          fields: [
            { field: wsBorsh.SOURCE_FIELD_TITLE, value: { String: 'shell' } },
            { field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Bytes16: PANE_EPOCH } },
          ],
        },
      ],
    };
  }

  getPaneIdentity(paneId: string) {
    return paneId === '%1' ? { paneId, paneEpoch: PANE_EPOCH } : null;
  }

  attachPaneConsumer(callbacks: PaneRetentionConsumerCallbacks) {
    return this.retention.attachConsumer(callbacks);
  }

  subscribe(listener: DeviceSessionRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getPaneScreenCheckpoint(): PaneScreenCheckpoint | null {
    return this.checkpoint;
  }

  readPaneReplay(paneId: string, cursor: PaneTerminalCursor) {
    return this.retention.readReplay(paneId, cursor);
  }

  async readPaneHistory(_paneId: string, _cursor: PaneHistoryCursor | null, _byteLimit: number) {
    return null;
  }

  async captureCanonicalScreen(
    paneId: string,
    byteLimit: number
  ): Promise<PaneScreenCheckpoint | null> {
    const cursor = this.retention.getLatestCursor(paneId);
    if (!cursor) return null;
    this.checkpoint = {
      paneId,
      paneEpoch: PANE_EPOCH,
      baseSeq: this.baseSeqOverride ?? cursor.terminalSeq,
      rows: 24,
      cols: 80,
      modes: 0,
      data: this.screenData.slice(0, byteLimit),
      historyCursor: null,
      capturedAt: Date.now(),
    };
    this.retention.storeScreenCheckpoint(this.checkpoint);
    return this.checkpoint;
  }

  sendInputBytes(paneId: string, data: Uint8Array): void {
    this.input.push([paneId, new TextDecoder().decode(data)]);
  }

  resizePane(paneId: string, cols: number, rows: number): void {
    this.resizes.push([paneId, cols, rows]);
  }

  output(data: string): void {
    this.retention.ingest('%1', PANE_EPOCH, encoder.encode(data));
  }
}

function target(deviceId = 'device-a') {
  return { deviceId, serverEpoch: SERVER_EPOCH, paneId: '%1' };
}

function createGuardedSender() {
  const events: wsBorsh.CanonicalEvent[] = [];
  const terminateReasons: string[] = [];
  let nextStatus = 1;
  let sendCalls = 0;
  let terminateCalls = 0;
  const socket = {
    send() {
      sendCalls += 1;
      return nextStatus;
    },
    terminate() {
      terminateCalls += 1;
    },
    getBufferedAmount() {
      return 0;
    },
  };
  const guard = new WebSocketSendGuard({
    timeoutMs: 5_000,
    onTerminate: (reason) => terminateReasons.push(reason),
  });
  const sendEvent = (event: wsBorsh.CanonicalEvent): CanonicalSendResult => {
    nextStatus = 'SourceGap' in event && !events.some((item) => 'SourceGap' in item) ? -1 : 1;
    const status = guard.sendFramesStatus(socket as never, [new Uint8Array([1])]);
    if (status !== 'dropped') events.push(event);
    if (status === 'backpressured') return 'backpressured';
    return status === 'sent';
  };
  return {
    events,
    terminateReasons,
    sendEvent,
    sendCalls: () => sendCalls,
    terminateCalls: () => terminateCalls,
    sourceGapCount: () => events.filter((event) => 'SourceGap' in event).length,
    drainGuard() {
      guard.handleDrain(socket as never);
    },
  };
}

describe('canonical feed session', () => {
  test('subscription only acks and passes live through; first screen is client-driven', async () => {
    const runtime = new FakeRuntime();
    const events: wsBorsh.CanonicalEvent[] = [];
    const session = new CanonicalFeedSession({
      maxFrameBytes: wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      resolveRuntime: async () => runtime,
      initialDeviceIds: () => ['device-a'],
    });

    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [{ pane: target(), cursor: null }],
        hotPanes: [],
      },
    });
    await Bun.sleep(0);
    runtime.output('live');
    await awaitPaneDataFlush();

    expect(events.map((event) => Object.keys(event)[0])).toEqual([
      'FeedReady',
      'SourceMetadataSnapshot',
      'SubscriptionApplied',
      'PaneData',
    ]);
    const paneData = events.find((event) => 'PaneData' in event);
    expect(paneData && 'PaneData' in paneData ? paneData.PaneData.seqStart : null).toBe(0n);
    expect(paneData && 'PaneData' in paneData ? paneData.PaneData.seqEnd : null).toBe(4n);
    expect(session.snapshotStats()).toMatchObject({
      attachedRuntimes: 1,
      pendingPaneGaps: 0,
      paneDataDeliveries: 1,
      paneDataBytes: 4,
      paneDataDrops: 0,
      screenTransactionsStarted: 0,
      screenTransactionsCompleted: 0,
    });

    await session.handleCommand({
      RequestScreen: {
        requestId: REQUEST_ID,
        pane: target(),
        byteLimit: CANONICAL_MAX_SCREEN_BYTES,
      },
    });
    await Bun.sleep(0);

    expect(events.slice(4).map((event) => Object.keys(event)[0])).toEqual([
      'ScreenBegin',
      'ScreenChunk',
      'ScreenCommit',
    ]);
    expect(session.snapshotStats()).toMatchObject({
      screenTransactionsStarted: 1,
      screenTransactionsCompleted: 1,
    });
    session.close();
  });

  test('uses semantic chunks that each fit a small negotiated frame', async () => {
    const runtime = new FakeRuntime();
    runtime.screenData = new Uint8Array(4_096).fill(0x61);
    const events: wsBorsh.CanonicalEvent[] = [];
    const session = new CanonicalFeedSession({
      maxFrameBytes: 512,
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      resolveRuntime: async () => runtime,
    });
    await session.handleCommand({
      RequestScreen: {
        requestId: REQUEST_ID,
        pane: target(),
        byteLimit: CANONICAL_MAX_SCREEN_BYTES,
      },
    });
    await Bun.sleep(0);

    const chunks = events.filter((event) => 'ScreenChunk' in event);
    expect(chunks.length).toBeGreaterThan(1);
    for (const event of events) {
      expect(wsBorsh.encodeCanonicalEventPayload(event).byteLength + 16).toBeLessThanOrEqual(512);
    }
    session.close();
  });

  test('validates epochs, deduplicates input IDs, and preserves monotonic subscriptions', async () => {
    const runtime = new FakeRuntime();
    const events: wsBorsh.CanonicalEvent[] = [];
    const session = new CanonicalFeedSession({
      maxFrameBytes: 32 * 1024,
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      resolveRuntime: async () => runtime,
    });
    const input = {
      requestId: REQUEST_ID,
      pane: target(),
      paneEpoch: PANE_EPOCH,
      inputId: new Uint8Array(16).fill(0x55),
      data: encoder.encode('x'),
    };
    await session.handleCommand({ TerminalInput: input });
    await session.handleCommand({ TerminalInput: input });
    expect(runtime.input).toEqual([['%1', 'x']]);

    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 5n,
        activePanes: [{ pane: target(), cursor: null }],
        hotPanes: [],
      },
    });
    await session.handleCommand({
      SetPaneSubscriptions: { generation: 4n, activePanes: [], hotPanes: [] },
    });
    const acknowledgements = events.filter((event) => 'SubscriptionApplied' in event);
    const last = acknowledgements.at(-1);
    expect(last && 'SubscriptionApplied' in last ? last.SubscriptionApplied.generation : null).toBe(
      5n
    );
    expect(
      last && 'SubscriptionApplied' in last ? last.SubscriptionApplied.activePanes : []
    ).toHaveLength(1);
    session.close();
  });

  test('splits pending pane batch at snapshot baseSeq: stale part dropped, rest after commit', async () => {
    const runtime = new FakeRuntime();
    const events: wsBorsh.CanonicalEvent[] = [];
    const session = new CanonicalFeedSession({
      maxFrameBytes: wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      resolveRuntime: async () => runtime,
      initialDeviceIds: () => ['device-a'],
    });
    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [{ pane: target(), cursor: null }],
        hotPanes: [],
      },
    });
    await Bun.sleep(0);
    // 'live'（seq 0..4）在合帧窗口内滞留；快照屏障落在 seq 3（'liv' 已含进快照，'e' 未含）
    runtime.output('live');
    runtime.baseSeqOverride = 3n;
    await session.handleCommand({
      RequestScreen: {
        requestId: REQUEST_ID,
        pane: target(),
        byteLimit: CANONICAL_MAX_SCREEN_BYTES,
      },
    });
    await Bun.sleep(0);

    const kinds = events.map((event) => Object.keys(event)[0]);
    expect(kinds).toEqual([
      'FeedReady',
      'SourceMetadataSnapshot',
      'SubscriptionApplied',
      'ScreenBegin',
      'ScreenChunk',
      'ScreenCommit',
      'PaneData',
    ]);
    const paneData = events.find((event) => 'PaneData' in event);
    if (!paneData || !('PaneData' in paneData)) throw new Error('missing PaneData');
    expect(paneData.PaneData.seqStart).toBe(3n);
    expect(paneData.PaneData.seqEnd).toBe(4n);
    expect(new TextDecoder().decode(paneData.PaneData.data)).toBe('e');
    session.close();
  });

  test('bounds pending pane gaps and escalates overflow to one stream rebase', async () => {
    const runtimes = new Map([
      ['device-a', new FakeRuntime('device-a')],
      ['device-b', new FakeRuntime('device-b')],
    ]);
    const events: wsBorsh.CanonicalEvent[] = [];
    const session = new CanonicalFeedSession({
      maxFrameBytes: 32 * 1024,
      maxPendingPaneGaps: 1,
      sendEvent: (event) => {
        if ('PaneData' in event) return false;
        events.push(event);
        return true;
      },
      resolveRuntime: async (deviceId) => runtimes.get(deviceId) ?? null,
    });

    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [
          { pane: target('device-a'), cursor: null },
          { pane: target('device-b'), cursor: null },
        ],
        hotPanes: [],
      },
    });
    await Bun.sleep(0);
    runtimes.get('device-a')?.output('a');
    runtimes.get('device-b')?.output('b');
    await awaitPaneDataFlush();

    expect(session.snapshotStats()).toMatchObject({
      pendingPaneGaps: 0,
      pendingPaneGapLimit: 1,
      streamGapPending: true,
      paneDataDrops: 2,
      paneDataDropBytes: 2,
      pendingPaneGapOverflows: 1,
    });

    session.onDrain();
    expect(session.snapshotStats()).toMatchObject({
      streamGapPending: false,
      streamGapsSent: 1,
    });
    expect(events.some((event) => 'SourceGap' in event && 'Stream' in event.SourceGap.scope)).toBe(
      true
    );
    session.close();
  });

  test('batches contiguous pane seq into one frame and flushes before a pane gap', async () => {
    const runtime = new FakeRuntime();
    const events: wsBorsh.CanonicalEvent[] = [];
    const session = new CanonicalFeedSession({
      maxFrameBytes: wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      resolveRuntime: async () => runtime,
      initialDeviceIds: () => ['device-a'],
    });
    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [{ pane: target(), cursor: null }],
        hotPanes: [],
      },
    });
    await Bun.sleep(0);
    runtime.output('ab');
    runtime.output('cd');
    await awaitPaneDataFlush();

    const paneData = events.filter((event) => 'PaneData' in event);
    expect(paneData).toHaveLength(1);
    if (!paneData[0] || !('PaneData' in paneData[0])) throw new Error('missing PaneData');
    expect(new TextDecoder().decode(paneData[0].PaneData.data)).toBe('abcd');
    expect(paneData[0].PaneData.seqStart).toBe(0n);
    expect(paneData[0].PaneData.seqEnd).toBe(4n);

    const nextEpoch = new Uint8Array(16).fill(0x99);
    runtime.output('xy');
    runtime.retention.reconcilePanes([{ paneId: '%1', paneEpoch: nextEpoch }]);
    await Bun.sleep(0);

    const kinds = events.map((event) => Object.keys(event)[0]);
    const paneDataIndex = kinds.lastIndexOf('PaneData');
    const gapIndex = kinds.lastIndexOf('SourceGap');
    expect(paneDataIndex).toBeGreaterThan(-1);
    expect(gapIndex).toBeGreaterThan(paneDataIndex);
    const flushed = events[paneDataIndex];
    if (!flushed || !('PaneData' in flushed)) throw new Error('missing flushed PaneData');
    expect(new TextDecoder().decode(flushed.PaneData.data)).toBe('xy');
    session.close();
  });

  test('rejects unknown panes and keeps generation when the set is empty on another device', async () => {
    const runtime = new FakeRuntime();
    const events: wsBorsh.CanonicalEvent[] = [];
    const session = new CanonicalFeedSession({
      maxFrameBytes: 32 * 1024,
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      resolveRuntime: async () => runtime,
    });
    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [
          { pane: { ...target(), paneId: '%missing' }, cursor: null },
          { pane: target(), cursor: null },
        ],
        hotPanes: [],
      },
    });
    const applied = events.find((event) => 'SubscriptionApplied' in event);
    if (!applied || !('SubscriptionApplied' in applied)) throw new Error('missing ack');
    expect(applied.SubscriptionApplied.generation).toBe(1n);
    expect(applied.SubscriptionApplied.activePanes).toEqual([target()]);
    expect(applied.SubscriptionApplied.rejected).toEqual([
      {
        pane: { ...target(), paneId: '%missing' },
        reason: wsBorsh.SUBSCRIPTION_REJECTED_NOT_FOUND,
      },
    ]);
    session.close();
  });

  test('queues a pane gap when SourceGap is not sent and retries on the pending sweep', async () => {
    const runtime = new FakeRuntime();
    const events: wsBorsh.CanonicalEvent[] = [];
    let blockGaps = true;
    const session = new CanonicalFeedSession({
      maxFrameBytes: 32 * 1024,
      sendEvent: (event) => {
        if (blockGaps && 'SourceGap' in event) return false;
        events.push(event);
        return true;
      },
      resolveRuntime: async () => runtime,
      initialDeviceIds: () => ['device-a'],
    });
    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [{ pane: target(), cursor: null }],
        hotPanes: [],
      },
    });
    const nextEpoch = new Uint8Array(16).fill(0x99);
    runtime.retention.reconcilePanes([{ paneId: '%1', paneEpoch: nextEpoch }]);
    expect(session.snapshotStats().pendingPaneGaps).toBe(1);

    blockGaps = false;
    await Bun.sleep(CANONICAL_PENDING_SWEEP_MS + 20);
    expect(session.snapshotStats().pendingPaneGaps).toBe(0);
    expect(session.snapshotStats().paneGapsSent).toBe(1);
    expect(events.some((event) => 'SourceGap' in event)).toBe(true);
    session.close();
  });

  test('SourceGap accepted under backpressure is not retried when sweep runs before drain', async () => {
    const runtime = new FakeRuntime();
    const guarded = createGuardedSender();
    const session = new CanonicalFeedSession({
      maxFrameBytes: 32 * 1024,
      sendEvent: guarded.sendEvent,
      resolveRuntime: async () => runtime,
      initialDeviceIds: () => ['device-a'],
    });
    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [{ pane: target(), cursor: null }],
        hotPanes: [],
      },
    });
    const nextEpoch = new Uint8Array(16).fill(0x99);
    runtime.retention.reconcilePanes([{ paneId: '%1', paneEpoch: nextEpoch }]);

    expect(guarded.sourceGapCount()).toBe(1);
    expect(session.snapshotStats().pendingPaneGaps).toBe(0);
    expect(session.snapshotStats().paneGapsSent).toBe(1);

    session.onDrain();
    expect(guarded.sourceGapCount()).toBe(1);
    expect(guarded.terminateReasons).toEqual([]);

    guarded.drainGuard();
    session.onDrain();
    expect(guarded.sourceGapCount()).toBe(1);
    expect(guarded.terminateReasons).toEqual([]);
    expect(guarded.terminateCalls()).toBe(0);

    await Bun.sleep(CANONICAL_PENDING_SWEEP_MS + 20);
    expect(guarded.sourceGapCount()).toBe(1);
    expect(guarded.terminateCalls()).toBe(0);
    session.close();
  });

  test('SourceGap accepted under backpressure is not duplicated when drain runs before sweep', async () => {
    const runtime = new FakeRuntime();
    const guarded = createGuardedSender();
    const session = new CanonicalFeedSession({
      maxFrameBytes: 32 * 1024,
      sendEvent: guarded.sendEvent,
      resolveRuntime: async () => runtime,
      initialDeviceIds: () => ['device-a'],
    });
    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [{ pane: target(), cursor: null }],
        hotPanes: [],
      },
    });
    const nextEpoch = new Uint8Array(16).fill(0x99);
    runtime.retention.reconcilePanes([{ paneId: '%1', paneEpoch: nextEpoch }]);

    expect(guarded.sourceGapCount()).toBe(1);
    expect(session.snapshotStats().pendingPaneGaps).toBe(0);
    expect(session.snapshotStats().paneGapsSent).toBe(1);

    guarded.drainGuard();
    session.onDrain();
    expect(guarded.sourceGapCount()).toBe(1);
    expect(guarded.terminateReasons).toEqual([]);
    expect(guarded.terminateCalls()).toBe(0);

    session.onDrain();
    await Bun.sleep(CANONICAL_PENDING_SWEEP_MS + 20);
    expect(guarded.sourceGapCount()).toBe(1);
    expect(guarded.terminateReasons).toEqual([]);
    expect(guarded.terminateCalls()).toBe(0);
    session.close();
  });
});
