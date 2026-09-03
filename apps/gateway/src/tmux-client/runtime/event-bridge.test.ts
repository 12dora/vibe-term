import { afterEach, describe, expect, test } from 'bun:test';
import { type StateSnapshotPayload, wsBorsh } from '@tmex/shared';

import { createControlModeSubscription } from '../control-mode-subscription';
import type { DeviceSessionRuntimeListener } from '../device-session-runtime';
import { MetadataProjection } from '../metadata-projection';
import { PaneHistoryReader } from '../pane-history-reader';
import { PaneRetention } from '../pane-retention';
import { clearSkippedPaneOutputsForDevice } from '../retention/skipped-output';
import { RuntimeEventBridge, stateSnapshotsEqual } from './event-bridge';
import {
  finishPaneOutputMaterializationRequest,
  requestPaneOutputMaterializationPredicate,
} from './output-materialization';

const SERVER_EPOCH = new Uint8Array(16).fill(1);
const encoder = new TextEncoder();

afterEach(() => clearSkippedPaneOutputsForDevice('device-a'));

function snapshotPaneTitle(payload: StateSnapshotPayload | null): string | undefined {
  return payload?.session?.windows[0]?.panes[0]?.title;
}

function snapshot(title = 'shell'): StateSnapshotPayload {
  return {
    deviceId: 'device-a',
    session: {
      id: '$1',
      name: 'work',
      windows: [
        {
          id: '@1',
          name: 'main',
          index: 0,
          active: true,
          layout: 'b25d,80x24,0,0,1',
          panes: [
            {
              id: '%1',
              windowId: '@1',
              index: 0,
              title,
              active: true,
              width: 80,
              height: 24,
              left: 0,
              top: 0,
            },
          ],
        },
      ],
    },
  };
}

describe('RuntimeEventBridge', () => {
  test('wires snapshot, metadata, output and close callbacks onto the runtime host', () => {
    const metadata = new MetadataProjection('device-a', { deviceName: 'Mac' });
    const paneRetention = new PaneRetention();
    const historyReader = new PaneHistoryReader({
      getPaneHistoryCaptureInfo: async () => ({ historySize: 0, cols: 80 }),
      capturePaneHistoryRange: async () => '',
    });
    let lastSnapshot: StateSnapshotPayload | null = null;
    const events: string[] = [];
    const listeners: DeviceSessionRuntimeListener[] = [
      {
        onEvent: (event) => events.push(`event:${event.type}`),
        onTerminalOutput: (paneId) => events.push(`out:${paneId}`),
        onSnapshot: (payload) => events.push(`snap:${payload.deviceId}`),
        onClose: () => events.push('close'),
      },
    ];
    let unexpectedCloses = 0;

    const bridge = new RuntimeEventBridge({
      metadata,
      paneRetention,
      getHistoryReader: () => historyReader,
      getLastSnapshot: () => lastSnapshot,
      setLastSnapshot: (payload) => {
        lastSnapshot = payload;
      },
      broadcast: (action) => {
        for (const listener of listeners) action(listener);
      },
      handleUnexpectedClose: () => {
        unexpectedCloses += 1;
        for (const listener of listeners) listener.onClose?.();
      },
    });

    const options = bridge.connectionOptions({ deviceId: 'device-a' });
    options.onSourceReady?.(SERVER_EPOCH);
    options.onEvent({ type: 'bell', data: { paneId: '%1' } });
    options.onSnapshot(snapshot());
    options.onSnapshot(snapshot());
    options.onTerminalOutput('%1', new Uint8Array([0x41]));
    options.onSourceMetadata?.({ type: 'pane-title', paneId: '%1', title: 'new' });
    options.onClose();

    expect(events).toEqual(['event:bell', 'snap:device-a', 'out:%1', 'close']);
    expect(unexpectedCloses).toBe(1);
    expect(snapshotPaneTitle(lastSnapshot)).toBe('shell');
    expect(metadata.revision).toBe(2n);
    expect(paneRetention.getLatestCursor('%1')?.terminalSeq).toBe(1n);
  });

  test('metadata patch callback applies a legacy snapshot diff', () => {
    const paneRetention = new PaneRetention();
    const historyReader = new PaneHistoryReader({
      getPaneHistoryCaptureInfo: async () => ({ historySize: 0, cols: 80 }),
      capturePaneHistoryRange: async () => '',
    });
    let lastSnapshot: StateSnapshotPayload | null = null;
    const patches: number[] = [];
    const host = {
      metadata: null as unknown as MetadataProjection,
      paneRetention,
      getHistoryReader: () => historyReader,
      getLastSnapshot: () => lastSnapshot,
      setLastSnapshot: (payload: StateSnapshotPayload) => {
        lastSnapshot = payload;
      },
      broadcast: (action: (listener: DeviceSessionRuntimeListener) => void) => {
        action({
          onMetadataPatch: () => {
            patches.push(1);
          },
        });
      },
      handleUnexpectedClose: () => undefined,
    };
    const bridge = new RuntimeEventBridge(host);
    host.metadata = new MetadataProjection('device-a', {
      deviceName: 'Mac',
      ...bridge.metadataCallbacks(),
    });
    const options = bridge.connectionOptions({ deviceId: 'device-a' });
    options.onSourceReady?.(SERVER_EPOCH);
    options.onSnapshot(snapshot());
    options.onSourceMetadata?.({ type: 'pane-title', paneId: '%1', title: 'patched' });
    host.metadata.flushPending();
    expect(snapshotPaneTitle(lastSnapshot)).toBe('patched');
    expect(patches).toEqual([1]);
  });

  test('stateSnapshotsEqual compares session/window/pane keys structurally', () => {
    const left = snapshot('shell');
    expect(stateSnapshotsEqual(null, left)).toBe(false);
    expect(stateSnapshotsEqual(left, snapshot('shell'))).toBe(true);
    expect(stateSnapshotsEqual(left, snapshot('other'))).toBe(false);
    expect(stateSnapshotsEqual(left, { ...left, deviceId: 'other' })).toBe(false);
    expect(
      stateSnapshotsEqual(
        { deviceId: 'device-a', session: null },
        { deviceId: 'device-a', session: null }
      )
    ).toBe(true);
  });

  test('cold panes stop materializing while bell and notification events remain live', () => {
    const metadata = new MetadataProjection('device-a');
    const paneRetention = new PaneRetention({ scheduleTimers: false });
    const historyReader = new PaneHistoryReader({
      getPaneHistoryCaptureInfo: async () => ({ historySize: 0, cols: 80 }),
      capturePaneHistoryRange: async () => '',
    });
    const outputs: string[] = [];
    const events: string[] = [];
    let lastSnapshot: StateSnapshotPayload | null = null;
    const bridge = new RuntimeEventBridge({
      metadata,
      paneRetention,
      getHistoryReader: () => historyReader,
      getLastSnapshot: () => lastSnapshot,
      setLastSnapshot: (payload) => {
        lastSnapshot = payload;
      },
      broadcast: (action) => {
        action({
          onTerminalOutput: (_paneId, data) => outputs.push(new TextDecoder().decode(data)),
          onEvent: (event) => events.push(event.type),
        });
      },
      handleUnexpectedClose: () => undefined,
    });
    const options = bridge.connectionOptions({ deviceId: 'device-a' });
    options.onSourceReady?.(SERVER_EPOCH);
    options.onSnapshot(snapshot());
    const subscription = createControlModeSubscription({
      onTerminalOutput: options.onTerminalOutput,
      onTitle: (paneId, title) => options.onSourceMetadata?.({ type: 'pane-title', paneId, title }),
      onBell: (paneId) => options.onEvent({ type: 'bell', data: { paneId } }),
      onNotification: (paneId, notification) =>
        options.onEvent({ type: 'notification', data: { paneId, ...notification } }),
      onStructureChanged: () => {},
      onExit: () => {},
    });

    subscription.push(encoder.encode('%output %1 bootstrap\n'));
    subscription.push(encoder.encode('%output %1 skipped\n'));
    subscription.push(encoder.encode('%output %1 A\\007B\n'));
    subscription.push(encoder.encode('%output %1 \\033]9;done\\007\n'));
    expect(outputs).toEqual(['bootstrap']);
    expect(events).toEqual(['bell', 'notification']);
    options.onSourceReady?.(SERVER_EPOCH);
    const staleCursor = paneRetention.getLatestCursor('%1');
    expect(staleCursor?.terminalSeq).toBe(9n);
    if (!staleCursor) throw new Error('expected stale cursor');
    const coldReplay = paneRetention.readReplay('%1', staleCursor);
    expect(coldReplay?.needsScreen).toBe(true);
    expect(coldReplay?.gap?.reason).toBe('cache_evicted');

    const paneEpoch = metadata.getPaneEpoch('%1');
    if (!paneEpoch) throw new Error('expected pane epoch');
    const retained: string[] = [];
    const lease = paneRetention.attachConsumer({
      onData: (segment) => retained.push(new TextDecoder().decode(segment.data)),
    });
    const applied = lease.applySubscriptions(
      1n,
      [{ paneId: '%1', paneEpoch, cursor: staleCursor }],
      []
    );
    expect(applied.replay[0]?.needsScreen).toBe(true);
    expect(applied.replay[0]?.gap?.reason).toBe('cache_evicted');
    subscription.push(encoder.encode('%output %1 visible\n'));
    expect(outputs).toEqual(['bootstrap', 'visible']);
    expect(retained).toEqual(['visible']);
    expect(paneRetention.getLatestCursor('%1')?.terminalSeq).toBe(16n);

    lease.close();
    subscription.dispose();
    paneRetention.dispose();
    metadata.dispose();
    historyReader.dispose();
  });

  test('materialized output does not hide an earlier cold-output gap from an old cursor', () => {
    const metadata = new MetadataProjection('device-a');
    const paneRetention = new PaneRetention({ scheduleTimers: false });
    const historyReader = new PaneHistoryReader({
      getPaneHistoryCaptureInfo: async () => ({ historySize: 0, cols: 80 }),
      capturePaneHistoryRange: async () => '',
    });
    let lastSnapshot: StateSnapshotPayload | null = null;
    const bridge = new RuntimeEventBridge({
      metadata,
      paneRetention,
      getHistoryReader: () => historyReader,
      getLastSnapshot: () => lastSnapshot,
      setLastSnapshot: (payload) => {
        lastSnapshot = payload;
      },
      broadcast: () => {},
      handleUnexpectedClose: () => undefined,
    });
    const options = bridge.connectionOptions({ deviceId: 'device-a' });
    options.onSourceReady?.(SERVER_EPOCH);
    options.onSnapshot(snapshot());
    const oldCursor = paneRetention.getLatestCursor('%1');
    if (!oldCursor) throw new Error('expected initial cursor');
    expect(oldCursor.terminalSeq).toBe(0n);

    const discoveryData = new Uint8Array();
    const request = requestPaneOutputMaterializationPredicate(discoveryData);
    options.onTerminalOutput('%1', discoveryData);
    const materializeOutput = finishPaneOutputMaterializationRequest(request);
    if (!materializeOutput) throw new Error('expected materialization predicate');
    const subscription = createControlModeSubscription(
      {
        onTerminalOutput: options.onTerminalOutput,
        onTitle: () => {},
        onBell: () => {},
        onNotification: () => {},
        onStructureChanged: () => {},
        onExit: () => {},
      },
      { materializeOutput }
    );

    subscription.push(encoder.encode(`%output %1 ${'x'.repeat(50)}\n`));
    expect(paneRetention.getLatestCursor('%1')?.terminalSeq).toBe(0n);

    const paneEpoch = metadata.getPaneEpoch('%1');
    if (!paneEpoch) throw new Error('expected pane epoch');
    const firstClient = paneRetention.attachConsumer({ onData: () => {} });
    firstClient.applySubscriptions(1n, [{ paneId: '%1', paneEpoch, cursor: oldCursor }], []);
    subscription.push(encoder.encode('%output %1 later\n'));
    expect(paneRetention.getLatestCursor('%1')?.terminalSeq).toBe(5n);

    const oldClient = paneRetention.attachConsumer({ onData: () => {} });
    const replay = oldClient.applySubscriptions(
      1n,
      [{ paneId: '%1', paneEpoch, cursor: oldCursor }],
      []
    ).replay[0];
    expect(replay?.needsScreen).toBe(true);
    expect(replay?.gap?.reason).toBe('cache_evicted');
    expect(replay?.segments).toEqual([]);

    oldClient.close();
    firstClient.close();
    subscription.dispose();
    paneRetention.dispose();
    metadata.dispose();
    historyReader.dispose();
  });

  test('moves a cold-output gap marker to the current pane epoch', () => {
    const epochA = new Uint8Array(16).fill(3);
    const epochB = new Uint8Array(16).fill(4);
    let currentEpoch = epochA;
    const metadata = new MetadataProjection('device-a');
    metadata.ensurePaneEpoch = () => currentEpoch.slice();
    const paneRetention = new PaneRetention({ scheduleTimers: false });
    paneRetention.reconcilePanes([{ paneId: '%1', paneEpoch: epochA }]);
    const historyReader = new PaneHistoryReader({
      getPaneHistoryCaptureInfo: async () => ({ historySize: 0, cols: 80 }),
      capturePaneHistoryRange: async () => '',
    });
    const bridge = new RuntimeEventBridge({
      metadata,
      paneRetention,
      getHistoryReader: () => historyReader,
      getLastSnapshot: () => null,
      setLastSnapshot: () => {},
      broadcast: () => {},
      handleUnexpectedClose: () => undefined,
    });
    const options = bridge.connectionOptions({ deviceId: 'device-a' });
    const discoveryData = new Uint8Array();
    const request = requestPaneOutputMaterializationPredicate(discoveryData);
    options.onTerminalOutput('%1', discoveryData);
    const materializeOutput = finishPaneOutputMaterializationRequest(request);
    if (!materializeOutput) throw new Error('expected materialization predicate');

    expect(materializeOutput('%1')).toBe(false);
    currentEpoch = epochB;
    paneRetention.reconcilePanes([{ paneId: '%1', paneEpoch: epochB }]);
    expect(materializeOutput('%1')).toBe(false);

    const replay = paneRetention.readReplay('%1', { paneEpoch: epochB, terminalSeq: 0n });
    expect(replay?.needsScreen).toBe(true);
    expect(replay?.gap?.reason).toBe('cache_evicted');

    paneRetention.dispose();
    metadata.dispose();
    historyReader.dispose();
  });
});

describe('RuntimeEventBridge snapshot dirty split', () => {
  test('identical consecutive snapshots skip retention/history and keep metadata revision', () => {
    const harness = createSnapshotHarness();
    harness.emit(snapshot(), 0n);
    expect(harness.reconcileCalls).toBe(1);
    expect(harness.retentionCalls).toBe(1);
    expect(harness.historyInvalidationCount).toBe(1);
    expect(harness.metadata.revision).toBe(1n);
    expect(harness.broadcastCount).toBe(1);

    harness.emit(snapshot(), harness.metadata.revision);
    expect(harness.reconcileCalls).toBe(1);
    expect(harness.retentionCalls).toBe(1);
    expect(harness.historyInvalidationCount).toBe(1);
    expect(harness.metadata.revision).toBe(1n);
    expect(harness.broadcastCount).toBe(1);
    expect(projectedPaneTitle(harness.metadata, '%1')).toBe('shell');
  });

  test('pane-set change still runs metadata, retention and history invalidation', () => {
    const harness = createSnapshotHarness();
    harness.emit(snapshot(), 0n);
    const afterEstablish = {
      reconcile: harness.reconcileCalls,
      retention: harness.retentionCalls,
      history: harness.historyInvalidationCount,
      revision: harness.metadata.revision,
    };

    harness.emit(twoPaneSnapshot(), harness.metadata.revision);
    expect(harness.reconcileCalls).toBe(afterEstablish.reconcile + 1);
    expect(harness.retentionCalls).toBe(afterEstablish.retention + 1);
    expect(harness.historyInvalidationCount).toBeGreaterThan(afterEstablish.history);
    expect(harness.metadata.revision).toBe(afterEstablish.revision + 1n);
    expect(harness.broadcastCount).toBe(2);
    expect(harness.metadata.hasPane('%2')).toBe(true);
    expect(harness.paneRetention.getLatestCursor('%2')).not.toBeNull();
  });

  test('removing a pane still reconciles retention and invalidates its history', () => {
    const harness = createSnapshotHarness();
    harness.emit(twoPaneSnapshot(), 0n);
    const historyBefore = harness.historyInvalidationCount;

    harness.emit(snapshot(), harness.metadata.revision);
    expect(harness.retentionCalls).toBe(2);
    expect(harness.historyInvalidationCount).toBeGreaterThan(historyBefore);
    expect(harness.metadata.hasPane('%2')).toBe(false);
    expect(harness.paneRetention.getLatestCursor('%2')).toBeNull();
  });

  test('metadata-only field change still reconciles but skips retention/history', () => {
    const harness = createSnapshotHarness();
    harness.emit(snapshot('shell'), 0n);
    const afterEstablish = {
      reconcile: harness.reconcileCalls,
      retention: harness.retentionCalls,
      history: harness.historyInvalidationCount,
    };

    harness.emit(snapshot('renamed'), harness.metadata.revision);
    expect(harness.reconcileCalls).toBe(afterEstablish.reconcile + 1);
    expect(harness.retentionCalls).toBe(afterEstablish.retention);
    expect(harness.historyInvalidationCount).toBe(afterEstablish.history);
    expect(harness.metadata.revision).toBe(2n);
    expect(projectedPaneTitle(harness.metadata, '%1')).toBe('renamed');
    expect(harness.broadcastCount).toBe(2);
  });

  test('stale snapshot during a source event does not revert newer metadata', () => {
    const harness = createSnapshotHarness();
    harness.emit(snapshot('old'), 0n);
    const queryBase = harness.metadata.revision;
    harness.options.onSourceMetadata?.({ type: 'pane-title', paneId: '%1', title: 'live' });
    expect(harness.metadata.revision).toBe(2n);

    harness.emit(snapshot('old'), queryBase);
    expect(harness.metadata.revision).toBe(2n);
    expect(projectedPaneTitle(harness.metadata, '%1')).toBe('live');
    expect(harness.retentionCalls).toBe(1);
    expect(harness.historyInvalidationCount).toBe(1);
  });

  test('server epoch reset re-establishes metadata and retention even if tmux snapshot matches', () => {
    const harness = createSnapshotHarness();
    harness.emit(snapshot(), 0n);
    const previousEpoch = harness.metadata.getPaneEpoch('%1');
    expect(previousEpoch).not.toBeNull();

    harness.options.onSourceReady?.(new Uint8Array(16).fill(7));
    expect(harness.metadata.revision).toBe(0n);

    harness.emit(snapshot(), 0n);
    expect(harness.reconcileCalls).toBe(2);
    expect(harness.retentionCalls).toBe(2);
    expect(harness.metadata.revision).toBe(1n);
    expect(harness.metadata.getPaneEpoch('%1')).not.toEqual(previousEpoch);
  });
});

function twoPaneSnapshot(): StateSnapshotPayload {
  const base = snapshot();
  const window = base.session?.windows[0];
  if (!window || !base.session) throw new Error('expected session window');
  return {
    ...base,
    session: {
      ...base.session,
      windows: [
        {
          ...window,
          panes: [
            ...window.panes,
            {
              id: '%2',
              windowId: '@1',
              index: 1,
              title: 'other',
              active: false,
              width: 80,
              height: 24,
              left: 0,
              top: 0,
            },
          ],
        },
      ],
    },
  };
}

function projectedPaneTitle(metadata: MetadataProjection, paneId: string): string | null {
  const record = metadata
    .currentSnapshot()
    .records.find(
      (candidate) =>
        candidate.key.entityKind === wsBorsh.SOURCE_ENTITY_PANE && candidate.key.nativeId === paneId
    );
  const value = record?.fields.find(
    (candidate) => candidate.field === wsBorsh.SOURCE_FIELD_TITLE
  )?.value;
  return value && 'String' in value ? value.String : null;
}

function createSnapshotHarness() {
  const metadata = new MetadataProjection('device-a', { deviceName: 'Mac' });
  const paneRetention = new PaneRetention();
  const historyReader = new PaneHistoryReader({
    getPaneHistoryCaptureInfo: async () => ({ historySize: 0, cols: 80 }),
    capturePaneHistoryRange: async () => '',
  });
  let lastSnapshot: StateSnapshotPayload | null = null;
  let reconcileCalls = 0;
  let retentionCalls = 0;
  let historyInvalidationCount = 0;
  let broadcastCount = 0;

  const originalReconcile = metadata.reconcile.bind(metadata);
  metadata.reconcile = (payload, baseRevision) => {
    reconcileCalls += 1;
    originalReconcile(payload, baseRevision);
  };
  const originalReconcilePanes = paneRetention.reconcilePanes.bind(paneRetention);
  paneRetention.reconcilePanes = (panes) => {
    retentionCalls += 1;
    originalReconcilePanes(panes);
  };
  const originalInvalidate = historyReader.invalidatePane.bind(historyReader);
  historyReader.invalidatePane = (paneId, paneEpoch) => {
    historyInvalidationCount += 1;
    originalInvalidate(paneId, paneEpoch);
  };

  const bridge = new RuntimeEventBridge({
    metadata,
    paneRetention,
    getHistoryReader: () => historyReader,
    getLastSnapshot: () => lastSnapshot,
    setLastSnapshot: (payload) => {
      lastSnapshot = payload;
    },
    broadcast: (action) => {
      action({
        onSnapshot: () => {
          broadcastCount += 1;
        },
      });
    },
    handleUnexpectedClose: () => undefined,
  });
  const options = bridge.connectionOptions({ deviceId: 'device-a' });
  options.onSourceReady?.(SERVER_EPOCH);
  return {
    metadata,
    paneRetention,
    options,
    emit(payload: StateSnapshotPayload, baseRevision?: bigint) {
      options.onSnapshot(payload, baseRevision);
    },
    get reconcileCalls() {
      return reconcileCalls;
    },
    get retentionCalls() {
      return retentionCalls;
    },
    get historyInvalidationCount() {
      return historyInvalidationCount;
    },
    get broadcastCount() {
      return broadcastCount;
    },
  };
}
