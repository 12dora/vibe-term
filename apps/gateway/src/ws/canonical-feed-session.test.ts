import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';

import type { DeviceSessionRuntimeListener } from '../tmux-client/device-session-runtime';
import type { PaneHistoryCursor, PaneHistoryPage } from '../tmux-client/pane-history-reader';
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
import { CANONICAL_MAX_HELD_PANE_BYTES } from './canonical/pane-stream';
import type { CanonicalSendResult } from './canonical/types';
import {
  GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS,
  GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES,
} from './terminal-output-batcher';
import { createFakeCarrier } from './test-helpers';
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
  openConsumers = 0;
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
    this.openConsumers += 1;
    const lease = this.retention.attachConsumer(callbacks);
    const close = lease.close.bind(lease);
    lease.close = () => {
      this.openConsumers -= 1;
      close();
    };
    return lease;
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

  async readPaneHistory(
    _paneId: string,
    _cursor: PaneHistoryCursor | null,
    _byteLimit: number
  ): Promise<PaneHistoryPage | null> {
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
  let nextStatus: 'sent' | 'backpressure' = 'sent';
  let sendCalls = 0;
  let terminateCalls = 0;
  const carrier = createFakeCarrier({
    send() {
      sendCalls += 1;
      return nextStatus;
    },
    terminate() {
      terminateCalls += 1;
    },
  });
  const guard = new WebSocketSendGuard({
    timeoutMs: 5_000,
    onTerminate: (reason) => terminateReasons.push(reason),
  });
  const sendEvent = (event: wsBorsh.CanonicalEvent): CanonicalSendResult => {
    nextStatus =
      'SourceGap' in event && !events.some((item) => 'SourceGap' in item) ? 'backpressure' : 'sent';
    const status = guard.sendFramesStatus(carrier, [new Uint8Array([1])]);
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
      guard.handleDrain(carrier);
    },
  };
}

function createTransactionBackpressure(shouldBlock: (event: wsBorsh.CanonicalEvent) => boolean): {
  events: wsBorsh.CanonicalEvent[];
  sendEvent: (event: wsBorsh.CanonicalEvent) => CanonicalSendResult;
  drain(): void;
} {
  const events: wsBorsh.CanonicalEvent[] = [];
  let blocked = false;
  let armed = true;
  return {
    events,
    sendEvent(event) {
      if (blocked) return false;
      events.push(event);
      if (armed && shouldBlock(event)) {
        armed = false;
        blocked = true;
        return 'backpressured';
      }
      return true;
    },
    drain() {
      blocked = false;
    },
  };
}

function installDelayedScreenCapture(runtime: FakeRuntime): {
  barrier: Promise<void>;
  release(): void;
} {
  let markBarrier!: () => void;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    markBarrier = resolve;
  });
  const completion = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.captureCanonicalScreen = async (paneId, byteLimit) => {
    const cursor = runtime.retention.getLatestCursor(paneId);
    markBarrier();
    await completion;
    if (!cursor) return null;
    runtime.checkpoint = {
      paneId,
      paneEpoch: cursor.paneEpoch,
      baseSeq: cursor.terminalSeq,
      rows: 24,
      cols: 80,
      modes: 0,
      data: runtime.screenData.slice(0, byteLimit),
      historyCursor: null,
      capturedAt: Date.now(),
    };
    return runtime.checkpoint;
  };
  return { barrier, release };
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

  test('replays retained pane data after the subscription acknowledgement on a cursor hit', async () => {
    const runtime = new FakeRuntime();
    const events: wsBorsh.CanonicalEvent[] = [];
    const session = new CanonicalFeedSession({
      maxFrameBytes: wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      resolveRuntime: async () => runtime,
    });

    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [{ pane: target(), cursor: null }],
        hotPanes: [],
      },
    });
    runtime.output('abcdef');
    await awaitPaneDataFlush();
    events.length = 0;

    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 2n,
        activePanes: [
          {
            pane: target(),
            cursor: { paneEpoch: PANE_EPOCH, terminalSeq: 3n },
          },
        ],
        hotPanes: [],
      },
    });

    expect(events.map((event) => Object.keys(event)[0])).toEqual([
      'SubscriptionApplied',
      'PaneData',
    ]);
    const replay = events[1];
    if (!replay || !('PaneData' in replay)) throw new Error('missing replay PaneData');
    expect(replay.PaneData.seqStart).toBe(3n);
    expect(replay.PaneData.seqEnd).toBe(6n);
    expect(new TextDecoder().decode(replay.PaneData.data)).toBe('def');
    session.close();
  });

  test('sends a gap after the subscription acknowledgement on a cursor miss without capturing a screen', async () => {
    const runtime = new FakeRuntime();
    const events: wsBorsh.CanonicalEvent[] = [];
    const session = new CanonicalFeedSession({
      maxFrameBytes: wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      resolveRuntime: async () => runtime,
    });

    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [{ pane: target(), cursor: null }],
        hotPanes: [],
      },
    });
    runtime.output('abc');
    await awaitPaneDataFlush();
    events.length = 0;

    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 2n,
        activePanes: [
          {
            pane: target(),
            cursor: { paneEpoch: PANE_EPOCH, terminalSeq: 99n },
          },
        ],
        hotPanes: [],
      },
    });

    expect(events.map((event) => Object.keys(event)[0])).toEqual([
      'SubscriptionApplied',
      'SourceGap',
    ]);
    const gap = events[1];
    if (!gap || !('SourceGap' in gap) || !('Pane' in gap.SourceGap.scope)) {
      throw new Error('missing pane SourceGap');
    }
    expect(gap.SourceGap.reason).toBe(wsBorsh.SOURCE_GAP_REASON_PANE_GAP);
    expect(gap.SourceGap.scope.Pane.expectedSeq).toBe(99n);
    expect(gap.SourceGap.scope.Pane.availableSeq).toBe(3n);
    expect(events.some((event) => 'ScreenBegin' in event)).toBe(false);
    expect(session.snapshotStats().screenTransactionsStarted).toBe(0);
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

  test('surfaces a stream gap after a screen transaction is interrupted by backpressure', async () => {
    const runtime = new FakeRuntime();
    runtime.screenData = new Uint8Array(1_024).fill(0x61);
    const sender = createTransactionBackpressure((event) => 'ScreenChunk' in event);
    const session = new CanonicalFeedSession({
      maxFrameBytes: 512,
      sendEvent: sender.sendEvent,
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
    expect(sender.events.some((event) => 'ScreenCommit' in event)).toBe(false);
    expect(sender.events.some((event) => 'SourceGap' in event)).toBe(false);

    sender.drain();
    session.onDrain();
    const gap = sender.events.find((event) => 'SourceGap' in event);
    expect(gap && 'SourceGap' in gap ? gap.SourceGap : null).toEqual({
      reason: wsBorsh.SOURCE_GAP_REASON_CACHE_EVICTED,
      scope: { Stream: {} },
    });
    session.close();
  });

  test('surfaces a stream gap after a history transaction is interrupted by backpressure', async () => {
    const runtime = new FakeRuntime();
    runtime.readPaneHistory = async () => ({
      paneId: '%1',
      paneEpoch: PANE_EPOCH,
      historyEpoch: new Uint8Array(16).fill(0x55),
      lineStart: 0,
      lineEnd: 1,
      truncated: false,
      data: new Uint8Array(1_024).fill(0x61),
      nextCursor: null,
    });
    const sender = createTransactionBackpressure((event) => 'HistoryChunk' in event);
    const session = new CanonicalFeedSession({
      maxFrameBytes: 512,
      sendEvent: sender.sendEvent,
      resolveRuntime: async () => runtime,
    });

    await session.handleCommand({
      RequestHistory: {
        requestId: REQUEST_ID,
        pane: target(),
        beforeCursor: null,
        byteLimit: 4_096,
      },
    });
    expect(sender.events.some((event) => 'HistoryCommit' in event)).toBe(false);
    expect(sender.events.some((event) => 'SourceGap' in event)).toBe(false);

    sender.drain();
    session.onDrain();
    const gap = sender.events.find((event) => 'SourceGap' in event);
    expect(gap && 'SourceGap' in gap ? gap.SourceGap : null).toEqual({
      reason: wsBorsh.SOURCE_GAP_REASON_CACHE_EVICTED,
      scope: { Stream: {} },
    });
    session.close();
  });

  test('deduplicates an in-flight history request ID and releases it after completion', async () => {
    const runtime = new FakeRuntime();
    let reads = 0;
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.readPaneHistory = async () => {
      reads += 1;
      markStarted();
      await pending;
      return {
        paneId: '%1',
        paneEpoch: PANE_EPOCH,
        historyEpoch: new Uint8Array(16).fill(0x55),
        lineStart: 0,
        lineEnd: 1,
        truncated: false,
        data: encoder.encode('history'),
        nextCursor: null,
      };
    };
    const session = new CanonicalFeedSession({
      maxFrameBytes: wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
      sendEvent: () => true,
      resolveRuntime: async () => runtime,
    });
    const command = {
      RequestHistory: {
        requestId: REQUEST_ID,
        pane: target(),
        beforeCursor: null,
        byteLimit: 4_096,
      },
    } satisfies wsBorsh.CanonicalCommand;

    const first = session.handleCommand(command);
    await started;
    await session.handleCommand(command);
    expect(reads).toBe(1);

    release();
    await first;
    await session.handleCommand(command);
    expect(reads).toBe(2);
    session.close();
  });

  test('routes resize through the session viewport arbiter when provided', async () => {
    const runtime = new FakeRuntime();
    const resizes: Array<[string, string, number, number]> = [];
    const session = new CanonicalFeedSession({
      maxFrameBytes: 512,
      sendEvent: () => true,
      resolveRuntime: async () => runtime,
      resizePane: (deviceId, paneId, cols, rows) => {
        resizes.push([deviceId, paneId, cols, rows]);
      },
    });

    await session.handleCommand({
      ResizePane: {
        requestId: REQUEST_ID,
        pane: target(),
        cols: 100,
        rows: 30,
      },
    });

    expect(resizes).toEqual([['device-a', '%1', 100, 30]]);
    expect(runtime.resizes).toEqual([]);
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

  test('holds live output until commit when capture completes after the batch window', async () => {
    const runtime = new FakeRuntime();
    const events: wsBorsh.CanonicalEvent[] = [];
    const session = new CanonicalFeedSession({
      maxFrameBytes: wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      resolveRuntime: async () => runtime,
    });
    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [{ pane: target(), cursor: null }],
        hotPanes: [],
      },
    });
    events.length = 0;
    const capture = installDelayedScreenCapture(runtime);

    await session.handleCommand({
      RequestScreen: {
        requestId: REQUEST_ID,
        pane: target(),
        byteLimit: CANONICAL_MAX_SCREEN_BYTES,
      },
    });
    await capture.barrier;
    expect(session.snapshotStats().gatedPanes).toBe(1);
    runtime.output('live');
    await awaitPaneDataFlush();
    expect(events).toEqual([]);

    capture.release();
    await Bun.sleep(0);
    expect(events.map((event) => Object.keys(event)[0])).toEqual([
      'ScreenBegin',
      'ScreenChunk',
      'ScreenCommit',
      'PaneData',
    ]);
    const live = events[3];
    if (!live || !('PaneData' in live)) throw new Error('missing held PaneData');
    expect(new TextDecoder().decode(live.PaneData.data)).toBe('live');
    expect(live.PaneData.seqStart).toBe(0n);
    expect(live.PaneData.seqEnd).toBe(4n);
    expect(session.snapshotStats().gatedPanes).toBe(0);
    session.close();
  });

  test('holds a segment above the batch threshold and emits all of it after commit', async () => {
    const runtime = new FakeRuntime();
    const events: wsBorsh.CanonicalEvent[] = [];
    const session = new CanonicalFeedSession({
      maxFrameBytes: wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      resolveRuntime: async () => runtime,
    });
    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [{ pane: target(), cursor: null }],
        hotPanes: [],
      },
    });
    events.length = 0;
    const capture = installDelayedScreenCapture(runtime);

    await session.handleCommand({
      RequestScreen: {
        requestId: REQUEST_ID,
        pane: target(),
        byteLimit: CANONICAL_MAX_SCREEN_BYTES,
      },
    });
    await capture.barrier;
    const liveBytes = GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES + 1_024;
    runtime.output('x'.repeat(liveBytes));
    await Bun.sleep(0);
    expect(events.some((event) => 'PaneData' in event)).toBe(false);

    capture.release();
    await Bun.sleep(0);
    const commitIndex = events.findIndex((event) => 'ScreenCommit' in event);
    const paneData = events
      .map((event, index) => ({ event, index }))
      .filter(
        (
          item
        ): item is {
          event: Extract<wsBorsh.CanonicalEvent, { PaneData: unknown }>;
          index: number;
        } => 'PaneData' in item.event
      );
    expect(commitIndex).toBeGreaterThan(-1);
    expect(paneData.length).toBeGreaterThan(1);
    expect(paneData.every(({ index }) => index > commitIndex)).toBe(true);
    let expectedSeq = 0n;
    let deliveredBytes = 0;
    for (const { event } of paneData) {
      expect(event.PaneData.seqStart).toBe(expectedSeq);
      expectedSeq = event.PaneData.seqEnd;
      deliveredBytes += event.PaneData.data.byteLength;
      expect(event.PaneData.data.every((byte) => byte === 0x78)).toBe(true);
    }
    expect(expectedSeq).toBe(BigInt(liveBytes));
    expect(deliveredBytes).toBe(liveBytes);
    session.close();
  });

  test('bounds held output and aborts the screen transaction with an explicit gap on overflow', async () => {
    const runtime = new FakeRuntime();
    const events: wsBorsh.CanonicalEvent[] = [];
    const session = new CanonicalFeedSession({
      maxFrameBytes: wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
      sendEvent: (event) => {
        events.push(event);
        return true;
      },
      resolveRuntime: async () => runtime,
    });
    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [{ pane: target(), cursor: null }],
        hotPanes: [],
      },
    });
    events.length = 0;
    const capture = installDelayedScreenCapture(runtime);

    await session.handleCommand({
      RequestScreen: {
        requestId: REQUEST_ID,
        pane: target(),
        byteLimit: CANONICAL_MAX_SCREEN_BYTES,
      },
    });
    await capture.barrier;
    const chunk = 'x'.repeat(GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES);
    const chunkCount =
      Math.floor(CANONICAL_MAX_HELD_PANE_BYTES / GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES) + 1;
    for (let index = 0; index < chunkCount; index += 1) runtime.output(chunk);

    expect(events.map((event) => Object.keys(event)[0])).toEqual(['SourceGap']);
    const gap = events[0];
    expect(gap && 'SourceGap' in gap ? gap.SourceGap : null).toEqual({
      reason: wsBorsh.SOURCE_GAP_REASON_RESOURCE_EXHAUSTED,
      scope: { Stream: {} },
    });
    expect(session.snapshotStats()).toMatchObject({
      gatedPanes: 1,
      paneDataDrops: 1,
      paneDataDropBytes: chunkCount * GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES,
    });

    capture.release();
    await Bun.sleep(0);
    expect(events.some((event) => 'ScreenBegin' in event || 'ScreenCommit' in event)).toBe(false);
    expect(session.snapshotStats()).toMatchObject({
      gatedPanes: 0,
      screenTransactionsFailed: 1,
    });
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

  test('carrier fallback discards pending pane data and sends the gap before metadata rebases', async () => {
    const runtime = new FakeRuntime();
    const events: wsBorsh.CanonicalEvent[] = [];
    let allowGap = false;
    const session = new CanonicalFeedSession({
      maxFrameBytes: wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
      sendEvent: (event) => {
        if ('SourceGap' in event && !allowGap) return false;
        events.push(event);
        return true;
      },
      resolveRuntime: async () => runtime,
    });
    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [{ pane: target(), cursor: null }],
        hotPanes: [],
      },
    });
    events.length = 0;
    runtime.output('discarded');

    session.onCarrierFallback();
    expect(events).toEqual([]);
    expect(session.snapshotStats().streamGapPending).toBe(true);

    allowGap = true;
    session.onDrain();
    expect(events.map((event) => Object.keys(event)[0])).toEqual([
      'SourceGap',
      'SourceMetadataSnapshot',
    ]);
    const gap = events[0];
    expect(gap && 'SourceGap' in gap ? gap.SourceGap : null).toEqual({
      reason: wsBorsh.SOURCE_GAP_REASON_CACHE_EVICTED,
      scope: { Stream: {} },
    });
    expect(events.some((event) => 'PaneData' in event)).toBe(false);
    session.close();
  });

  test('carrier fallback clears stale direct backpressure before rebasing on primary', async () => {
    const runtime = new FakeRuntime();
    const events: wsBorsh.CanonicalEvent[] = [];
    let backpressurePane = true;
    const session = new CanonicalFeedSession({
      maxFrameBytes: wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
      sendEvent: (event) => {
        events.push(event);
        if ('PaneData' in event && backpressurePane) return 'backpressured';
        return true;
      },
      resolveRuntime: async () => runtime,
    });
    await session.handleCommand({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [{ pane: target(), cursor: null }],
        hotPanes: [],
      },
    });
    events.length = 0;
    runtime.output('old-direct');
    await awaitPaneDataFlush();
    expect(events.some((event) => 'PaneData' in event)).toBe(true);
    events.length = 0;
    backpressurePane = false;

    session.onCarrierFallback();
    await Bun.sleep(CANONICAL_PENDING_SWEEP_MS + 20);

    expect(events.map((event) => Object.keys(event)[0])).toEqual([
      'SourceGap',
      'SourceMetadataSnapshot',
    ]);
    session.close();
  });

  test('coalesces metadata rebase while a snapshot is already pending', async () => {
    const runtime = new FakeRuntime();
    let snapshotAttempts = 0;
    let allowSnapshot = true;
    const session = new CanonicalFeedSession({
      maxFrameBytes: 32 * 1024,
      sendEvent: (event) => {
        if ('SourceMetadataSnapshot' in event) {
          snapshotAttempts += 1;
          if (!allowSnapshot) return false;
        }
        return true;
      },
      resolveRuntime: async () => runtime,
    });
    expect(await session.attachDevice('device-a')).toBe(true);
    const afterAttach = snapshotAttempts;
    expect(afterAttach).toBe(1);

    allowSnapshot = false;
    for (const listener of runtime.listeners) {
      listener.onMetadataRebaseRequired?.(runtime.getMetadataSnapshot());
    }
    expect(snapshotAttempts).toBe(afterAttach + 1);
    for (const listener of runtime.listeners) {
      listener.onMetadataRebaseRequired?.(runtime.getMetadataSnapshot());
    }
    expect(snapshotAttempts).toBe(afterAttach + 1);

    allowSnapshot = true;
    session.onDrain();
    expect(snapshotAttempts).toBe(afterAttach + 2);
    session.close();
  });

  test('serializes concurrent attachDevice for the same device and keeps one consumer', async () => {
    const runtime = new FakeRuntime();
    let release!: (value: CanonicalFeedRuntime | null) => void;
    const barrier = new Promise<CanonicalFeedRuntime | null>((resolve) => {
      release = resolve;
    });
    const session = new CanonicalFeedSession({
      maxFrameBytes: 32 * 1024,
      sendEvent: () => true,
      resolveRuntime: async () => barrier,
    });
    const first = session.attachDevice('device-a');
    const second = session.attachDevice('device-a');
    release(runtime);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(runtime.openConsumers).toBe(1);
    expect(runtime.listeners.size).toBe(1);
    session.close();
    expect(runtime.openConsumers).toBe(0);
    expect(runtime.listeners.size).toBe(0);
  });

  test('cleans up when attach fails or the session closes during resolve', async () => {
    const runtime = new FakeRuntime();
    let release!: (value: CanonicalFeedRuntime | null) => void;
    const barrier = new Promise<CanonicalFeedRuntime | null>((resolve) => {
      release = resolve;
    });
    const session = new CanonicalFeedSession({
      maxFrameBytes: 32 * 1024,
      sendEvent: () => true,
      resolveRuntime: async () => barrier,
    });
    const pending = session.attachDevice('device-a');
    const concurrent = session.attachDevice('device-a');
    session.close();
    release(runtime);
    expect(await pending).toBe(false);
    expect(await concurrent).toBe(false);
    expect(runtime.openConsumers).toBe(0);
    expect(runtime.listeners.size).toBe(0);

    const failed = new CanonicalFeedSession({
      maxFrameBytes: 32 * 1024,
      sendEvent: () => true,
      resolveRuntime: async () => null,
    });
    expect(await failed.attachDevice('device-a')).toBe(false);
    expect(await failed.attachDevice('device-a')).toBe(false);
    failed.close();
  });

  test('closes the lease and listener if the session closes while installing', async () => {
    const runtime = new FakeRuntime();
    const holder: { session: CanonicalFeedSession | null } = { session: null };
    const attach = runtime.attachPaneConsumer.bind(runtime);
    runtime.attachPaneConsumer = (callbacks) => {
      holder.session?.close();
      return attach(callbacks);
    };
    holder.session = new CanonicalFeedSession({
      maxFrameBytes: 32 * 1024,
      sendEvent: () => true,
      resolveRuntime: async () => runtime,
    });
    expect(await holder.session.attachDevice('device-a', runtime)).toBe(false);
    expect(runtime.openConsumers).toBe(0);
    expect(runtime.listeners.size).toBe(0);
  });
});
