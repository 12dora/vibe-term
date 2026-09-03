import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
  type MetadataLiveCaches,
  applyMetadataIdentity,
  applySubscriptionRejections,
  assembleDeviceMetadata,
  decidePaneData,
  deletePrefixedPaneKeys,
  deviceIdsFromMetadataPatch,
  groupRecordsByDevice,
  ingestMetadataPatch,
  ingestMetadataSnapshot,
  metadataPatchMatchesState,
  paneEpochsFromRecords,
  patchRecordsForDevice,
  plannedSubscriptions,
  sameStringList,
  shouldSkipSubscriptionSend,
} from './canonical-metadata-identity';
import {
  type DeviceMetadataState,
  type MetadataPatchEvent,
  ZERO_EPOCH,
  bytesEqual,
  copyBytes,
  paneKey,
} from './canonical-state-helpers';

const SERVER_EPOCH = new Uint8Array(16).fill(0x11);
const NEXT_SERVER_EPOCH = new Uint8Array(16).fill(0x12);
const PANE_EPOCH = new Uint8Array(16).fill(0x22);
const NEXT_PANE_EPOCH = new Uint8Array(16).fill(0x23);
const METADATA_EPOCH = new Uint8Array(16).fill(0x33);

function entityKey(
  entityKind: number,
  nativeId: string,
  deviceId = 'device-a',
  serverEpoch = SERVER_EPOCH
): wsBorsh.SourceEntityKey {
  return { deviceId, serverEpoch, entityKind, nativeId };
}

function paneRecord(
  paneId: string,
  paneEpoch: Uint8Array | 'unset' | null = PANE_EPOCH,
  deviceId = 'device-a',
  serverEpoch = SERVER_EPOCH
): wsBorsh.SourceMetadataRecord {
  const fields: wsBorsh.SourceMetadataRecord['fields'] = [
    { field: wsBorsh.SOURCE_FIELD_INDEX, value: { U32: 0 } },
  ];
  if (paneEpoch === 'unset') {
    fields.push({ field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Unset: {} } });
  } else if (paneEpoch) {
    fields.push({ field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Bytes16: paneEpoch } });
  }
  return {
    key: entityKey(wsBorsh.SOURCE_ENTITY_PANE, paneId, deviceId, serverEpoch),
    parent: entityKey(wsBorsh.SOURCE_ENTITY_WINDOW, '@1', deviceId, serverEpoch),
    fields,
  };
}

function emptyState(overrides: Partial<DeviceMetadataState> = {}): DeviceMetadataState {
  return {
    metadataEpoch: copyBytes(METADATA_EPOCH),
    revision: 1n,
    serverEpoch: copyBytes(SERVER_EPOCH),
    paneEpochs: new Map([['%1', copyBytes(PANE_EPOCH)]]),
    treeOrder: wsBorsh.createCanonicalTreeOrder(),
    baseSnapshot: { deviceId: 'device-a', session: null },
    snapshot: { deviceId: 'device-a', session: null },
    ...overrides,
  };
}

function paneData(
  overrides: Partial<{
    serverEpoch: Uint8Array;
    paneEpoch: Uint8Array;
    seqStart: bigint;
    seqEnd: bigint;
    data: Uint8Array;
    paneId: string;
  }> = {}
) {
  const data = overrides.data ?? new Uint8Array([1, 2, 3]);
  const seqStart = overrides.seqStart ?? 0n;
  return {
    pane: {
      deviceId: 'device-a',
      serverEpoch: overrides.serverEpoch ?? SERVER_EPOCH,
      paneId: overrides.paneId ?? '%1',
    },
    paneEpoch: overrides.paneEpoch ?? PANE_EPOCH,
    seqStart,
    seqEnd: overrides.seqEnd ?? seqStart + BigInt(data.byteLength),
    data,
  };
}

function fakeCaches(metadata: Map<string, DeviceMetadataState>): MetadataLiveCaches & {
  snapshots: unknown[];
  patches: unknown[];
  gaps: Array<string | undefined>;
  cleared: string[];
  cancelled: string[];
  dropped: string[];
  droppedSizeEpochs: string[];
} {
  const snapshots: unknown[] = [];
  const patches: unknown[] = [];
  const gaps: Array<string | undefined> = [];
  const cleared: string[] = [];
  const cancelled: string[] = [];
  const dropped: string[] = [];
  const droppedSizeEpochs: string[] = [];
  return {
    metadata,
    awaitingMetadataDevices: new Set(metadata.keys()),
    epochRecoveryDevices: new Set(),
    terminalCursors: new Map(),
    blockedPanes: new Set(),
    clearPaneStateForDevice: (deviceId) => cleared.push(deviceId),
    cancelPane: (deviceId, paneId) => cancelled.push(`${deviceId}:${paneId}`),
    dropPendingPane: (deviceId, paneId) => dropped.push(`${deviceId}:${paneId}`),
    dropSizeEpoch: (deviceId, paneId) => droppedSizeEpochs.push(`${deviceId}:${paneId}`),
    resolvedRecovery: () => {},
    resolvedSubscriptionRetry: () => {},
    emitSnapshot: (snapshot) => snapshots.push(snapshot),
    emitPatch: (deviceId, snapshot) => patches.push({ deviceId, snapshot }),
    emitMetadataGap: (deviceId) => gaps.push(deviceId),
    snapshots,
    patches,
    gaps,
    cleared,
    cancelled,
    dropped,
    droppedSizeEpochs,
  };
}

describe('canonical metadata identity', () => {
  test('groups records and extracts pane epochs, ignoring non-pane entities', () => {
    const session = {
      key: entityKey(wsBorsh.SOURCE_ENTITY_SESSION, '$1'),
      parent: null,
      fields: [],
    };
    const paneB = paneRecord('%2', NEXT_PANE_EPOCH, 'device-b', NEXT_SERVER_EPOCH);
    const grouped = groupRecordsByDevice([session, paneRecord('%1'), paneB]);
    expect([...grouped.keys()]).toEqual(['device-a', 'device-b']);
    expect(grouped.get('device-a')).toHaveLength(2);
    const epochs = paneEpochsFromRecords([session, paneRecord('%1'), paneB]);
    expect(epochs.get('%1')).toEqual(PANE_EPOCH);
    expect(epochs.get('%2')).toEqual(NEXT_PANE_EPOCH);
    expect(epochs.size).toBe(2);
  });

  test('assembleDeviceMetadata 从首条记录的 server epoch 建状态并初始化顺序表', () => {
    const assembled = assembleDeviceMetadata('device-a', METADATA_EPOCH, 4n, [paneRecord('%1')]);
    expect(assembled?.revision).toBe(4n);
    expect(assembled?.serverEpoch).toEqual(SERVER_EPOCH);
    expect(assembled?.paneEpochs.get('%1')).toEqual(PANE_EPOCH);
    expect(assembled?.treeOrder.windows.size).toBe(0);
    expect(assembled?.treeOrder.panes.size).toBe(0);
    expect(assembleDeviceMetadata('device-a', METADATA_EPOCH, 1n, [])).toBeNull();
  });

  test('applyMetadataIdentity reports server-epoch, pane removal, change and unset', () => {
    const state = emptyState();
    const epochActions = applyMetadataIdentity(
      state,
      [paneRecord('%1', NEXT_PANE_EPOCH, 'device-a', NEXT_SERVER_EPOCH)],
      []
    );
    expect(epochActions.map((item) => item.kind)).toEqual(['server-epoch-changed']);
    expect(state.serverEpoch).toEqual(NEXT_SERVER_EPOCH);
    expect(state.paneEpochs.size).toBe(1);
    expect(state.paneEpochs.get('%1')).toEqual(NEXT_PANE_EPOCH);

    const next = emptyState();
    const mixed = applyMetadataIdentity(
      next,
      [paneRecord('%1', NEXT_PANE_EPOCH), paneRecord('%2', 'unset')],
      [entityKey(wsBorsh.SOURCE_ENTITY_PANE, '%3'), entityKey(wsBorsh.SOURCE_ENTITY_WINDOW, '@1')]
    );
    expect(mixed).toEqual([
      { kind: 'pane-removed', deviceId: 'device-a', paneId: '%3' },
      { kind: 'pane-epoch-changed', deviceId: 'device-a', paneId: '%1' },
      { kind: 'pane-epoch-unset', deviceId: 'device-a', paneId: '%2' },
    ]);
    expect(next.paneEpochs.get('%1')).toEqual(NEXT_PANE_EPOCH);
    expect(next.paneEpochs.has('%2')).toBe(false);
    expect(applyMetadataIdentity(emptyState(), [paneRecord('%1')], [])).toEqual([]);
  });

  test('metadata patch helpers split device records and match epoch/revision', () => {
    const event: MetadataPatchEvent = {
      metadataEpoch: METADATA_EPOCH,
      fromRevision: 1n,
      throughRevision: 2n,
      upserts: [paneRecord('%1'), paneRecord('%9', PANE_EPOCH, 'device-b')],
      removals: [entityKey(wsBorsh.SOURCE_ENTITY_PANE, '%2')],
    };
    expect([...deviceIdsFromMetadataPatch(event)].sort()).toEqual(['device-a', 'device-b']);
    expect(patchRecordsForDevice(event, 'device-a').upserts).toHaveLength(1);
    expect(patchRecordsForDevice(event, 'device-a').removals).toHaveLength(1);
    expect(metadataPatchMatchesState(emptyState(), event)).toBe(true);
    expect(metadataPatchMatchesState(undefined, event)).toBe(false);
    expect(metadataPatchMatchesState(emptyState({ revision: 0n }), event)).toBe(false);
  });

  test('ingest snapshot recovers awaiting devices and patch applies identity side effects', () => {
    const caches = fakeCaches(new Map());
    caches.awaitingMetadataDevices.add('device-a');
    const recovered = ingestMetadataSnapshot(caches, METADATA_EPOCH, 1n, [paneRecord('%1')]);
    expect(recovered).toBe(true);
    expect(caches.snapshots).toHaveLength(1);
    expect(caches.awaitingMetadataDevices.size).toBe(0);

    const state = caches.metadata.get('device-a');
    if (!state) throw new Error('missing assembled metadata');
    const inverted = ingestMetadataPatch(caches, {
      metadataEpoch: METADATA_EPOCH,
      fromRevision: 2n,
      throughRevision: 1n,
      upserts: [],
      removals: [],
    });
    expect(inverted).toBe('global-gap');

    const applied = ingestMetadataPatch(caches, {
      metadataEpoch: METADATA_EPOCH,
      fromRevision: 1n,
      throughRevision: 2n,
      upserts: [paneRecord('%1', NEXT_PANE_EPOCH)],
      removals: [entityKey(wsBorsh.SOURCE_ENTITY_PANE, '%gone')],
    });
    expect(applied).toBe('applied');
    expect(caches.cancelled).toEqual(['device-a:%gone']);
    expect(caches.dropped).toEqual(['device-a:%gone']);
    // pane 消失同时要剪掉它的 sizeEpoch 条目，否则账本随 pane 增删单调增长
    expect(caches.droppedSizeEpochs).toEqual(['device-a:%gone']);
    expect(state.paneEpochs.get('%1')).toEqual(NEXT_PANE_EPOCH);
    expect(caches.blockedPanes.has(paneKey('device-a', '%1'))).toBe(true);
    expect(caches.patches).toHaveLength(1);
  });

  test('decidePaneData covers ignore, gap, rebase and overlapping emit', () => {
    const device = emptyState();
    expect(
      decidePaneData(paneData(), {
        blocked: true,
        awaitingMetadata: false,
        device,
        cursor: undefined,
      }).kind
    ).toBe('ignore');
    expect(
      decidePaneData(paneData(), {
        blocked: false,
        awaitingMetadata: true,
        device,
        cursor: undefined,
      }).kind
    ).toBe('ignore');
    expect(
      decidePaneData(paneData(), {
        blocked: false,
        awaitingMetadata: false,
        device: undefined,
        cursor: undefined,
      }).kind
    ).toBe('metadata-gap');
    expect(
      decidePaneData(paneData({ serverEpoch: NEXT_SERVER_EPOCH }), {
        blocked: false,
        awaitingMetadata: false,
        device,
        cursor: undefined,
      })
    ).toEqual({ kind: 'rebase', reason: 'epoch_changed' });
    expect(
      decidePaneData(paneData({ paneEpoch: NEXT_PANE_EPOCH }), {
        blocked: false,
        awaitingMetadata: false,
        device,
        cursor: undefined,
      })
    ).toEqual({ kind: 'rebase', reason: 'epoch_changed' });

    const cursor = { paneEpoch: copyBytes(PANE_EPOCH), terminalSeq: 4n };
    expect(
      decidePaneData(paneData({ seqStart: 5n, data: new Uint8Array([9]) }), {
        blocked: false,
        awaitingMetadata: false,
        device,
        cursor,
      })
    ).toEqual({ kind: 'rebase', reason: 'pane_gap' });
    expect(
      decidePaneData(paneData({ seqStart: 0n, seqEnd: 3n, data: new Uint8Array([1, 2, 3]) }), {
        blocked: false,
        awaitingMetadata: false,
        device,
        cursor,
      }).kind
    ).toBe('ignore');

    const overlap = decidePaneData(paneData({ seqStart: 2n, data: new Uint8Array([1, 2, 3, 4]) }), {
      blocked: false,
      awaitingMetadata: false,
      device,
      cursor,
    });
    expect(overlap).toEqual({ kind: 'emit', seqStart: 4n, data: new Uint8Array([3, 4]) });
    expect(
      decidePaneData(paneData({ seqStart: 4n, data: new Uint8Array([7, 8]) }), {
        blocked: false,
        awaitingMetadata: false,
        device,
        cursor,
      })
    ).toEqual({ kind: 'emit', seqStart: 4n, data: new Uint8Array([7, 8]) });
  });

  test('plannedSubscriptions skips recovery devices and copies identity bytes', () => {
    const desired = new Map([
      ['device-b', { paneIds: ['%2'] }],
      ['device-a', { paneIds: ['%1'] }],
    ]);
    const metadata = new Map([['device-a', emptyState()]]);
    const cursors = new Map([
      [paneKey('device-a', '%1'), { paneEpoch: copyBytes(PANE_EPOCH), terminalSeq: 9n }],
    ]);
    const planned = plannedSubscriptions(desired, metadata, cursors, new Set(['device-b']));
    expect(planned.activePanes.map((item) => item.pane.deviceId)).toEqual(['device-a']);
    expect(planned.activePanes[0]?.pane.serverEpoch).toEqual(SERVER_EPOCH);
    expect(planned.activePanes[0]?.cursor?.terminalSeq).toBe(9n);
    expect(planned.identityFingerprint.includes('device-a')).toBe(true);
    expect(planned.fingerprint).not.toBe(planned.identityFingerprint);

    const empty = plannedSubscriptions(desired, new Map(), new Map(), new Set());
    expect(bytesEqual(empty.activePanes[0]?.pane.serverEpoch ?? new Uint8Array(), ZERO_EPOCH)).toBe(
      true
    );
  });

  test('subscription skip, string equality, prefixed key deletion and rejections', () => {
    expect(sameStringList(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameStringList(['a'], ['b'])).toBe(false);
    expect(shouldSkipSubscriptionSend(true, 1n, 'f', 'i', 'f', 'i')).toBe(false);
    expect(shouldSkipSubscriptionSend(false, 0n, 'f', 'i', 'f', 'i')).toBe(false);
    expect(shouldSkipSubscriptionSend(false, 1n, 'f', 'i', 'f', 'i')).toBe(true);
    expect(shouldSkipSubscriptionSend(false, 1n, 'other', 'i', 'f', 'i')).toBe(true);
    expect(shouldSkipSubscriptionSend(false, 1n, 'other', 'other', 'f', 'i')).toBe(false);

    const cursors = new Map([
      [paneKey('device-a', '%1'), { paneEpoch: PANE_EPOCH, terminalSeq: 1n }],
      [paneKey('device-b', '%1'), { paneEpoch: PANE_EPOCH, terminalSeq: 1n }],
    ]);
    const blocked = new Set([paneKey('device-a', '%1'), paneKey('device-b', '%1')]);
    deletePrefixedPaneKeys(cursors, 'device-a');
    deletePrefixedPaneKeys(blocked, 'device-a');
    expect(cursors.has(paneKey('device-a', '%1'))).toBe(false);
    expect(cursors.has(paneKey('device-b', '%1'))).toBe(true);
    expect(blocked.has(paneKey('device-a', '%1'))).toBe(false);

    const dropped: string[] = [];
    const [epochChanged, exhausted] = applySubscriptionRejections(
      [
        { deviceId: 'device-a', paneId: '%1', reason: 'not_found' },
        { deviceId: 'device-a', paneId: '%2', reason: 'resource_exhausted' },
        { deviceId: 'device-a', paneId: '%3', reason: 'epoch_changed' },
        { deviceId: 'missing', paneId: '%1', reason: 'epoch_changed' },
      ],
      new Map([[paneKey('device-a', '%1'), { paneEpoch: PANE_EPOCH, terminalSeq: 1n }]]),
      new Set([paneKey('device-a', '%1')]),
      (deviceId) => deviceId === 'device-a',
      (deviceId, paneId) => dropped.push(`${deviceId}:${paneId}`)
    );
    expect(dropped).toEqual(['device-a:%1']);
    expect(exhausted).toBe(true);
    expect([...epochChanged]).toEqual(['device-a']);
  });
});
