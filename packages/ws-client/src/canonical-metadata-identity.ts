import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import {
  type DesiredSubscriptions,
  type DeviceMetadataState,
  type MetadataPatchEvent,
  type PaneDataEvent,
  ZERO_EPOCH,
  bytesEqual,
  bytesKey,
  copyBytes,
  paneKey,
} from './canonical-state-helpers';
import type { GatewayRebaseReason, GatewaySubscriptionRejection } from './transport-types';

export type MetadataIdentityAction =
  | { kind: 'server-epoch-changed'; deviceId: string }
  | { kind: 'pane-removed'; deviceId: string; paneId: string }
  | { kind: 'pane-epoch-changed'; deviceId: string; paneId: string }
  | { kind: 'pane-epoch-unset'; deviceId: string; paneId: string };

export type PaneDataDecision =
  | { kind: 'ignore' }
  | { kind: 'metadata-gap' }
  | { kind: 'rebase'; reason: Extract<GatewayRebaseReason, 'epoch_changed' | 'pane_gap'> }
  | { kind: 'emit'; seqStart: bigint; data: Uint8Array };

export interface MetadataLiveCaches {
  metadata: Map<string, DeviceMetadataState>;
  awaitingMetadataDevices: Set<string>;
  epochRecoveryDevices: Set<string>;
  terminalCursors: Map<string, wsBorsh.CanonicalTerminalCursor>;
  blockedPanes: Set<string>;
  clearPaneStateForDevice(deviceId: string): void;
  cancelPane(deviceId: string, paneId: string): void;
  dropPendingPane(deviceId: string, paneId: string): void;
  /** pane 消失时丢掉它的 sizeEpoch 账本条目，否则 map 会随 pane 增删单调增长 */
  dropSizeEpoch(deviceId: string, paneId: string): void;
  resolvedRecovery(deviceId: string): void;
  resolvedSubscriptionRetry(): void;
  emitSnapshot(snapshot: StateSnapshotPayload): void;
  emitPatch(deviceId: string, snapshot: StateSnapshotPayload): void;
  emitMetadataGap(deviceId?: string): void;
}

export function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function paneEpochsFromRecords(
  records: readonly wsBorsh.SourceMetadataRecord[]
): Map<string, Uint8Array> {
  const epochs = new Map<string, Uint8Array>();
  for (const record of records) {
    if (record.key.entityKind !== wsBorsh.SOURCE_ENTITY_PANE) continue;
    const field = record.fields.find((item) => item.field === wsBorsh.SOURCE_FIELD_PANE_EPOCH);
    if (field && 'Bytes16' in field.value) {
      epochs.set(record.key.nativeId, copyBytes(field.value.Bytes16));
    }
  }
  return epochs;
}

export function groupRecordsByDevice(
  records: readonly wsBorsh.SourceMetadataRecord[]
): Map<string, wsBorsh.SourceMetadataRecord[]> {
  const byDevice = new Map<string, wsBorsh.SourceMetadataRecord[]>();
  for (const record of records) {
    const group = byDevice.get(record.key.deviceId) ?? [];
    group.push(record);
    byDevice.set(record.key.deviceId, group);
  }
  return byDevice;
}

export function assembleDeviceMetadata(
  deviceId: string,
  metadataEpoch: Uint8Array,
  revision: bigint,
  deviceRecords: readonly wsBorsh.SourceMetadataRecord[]
): DeviceMetadataState | null {
  const serverEpoch = deviceRecords[0]?.key.serverEpoch;
  if (!serverEpoch) return null;
  const projection = wsBorsh.sourceMetadataPatchToLegacyDiff({
    metadataEpoch,
    fromRevision: 0n,
    throughRevision: revision,
    upserts: [...deviceRecords],
    removals: [],
  });
  const treeOrder = wsBorsh.createCanonicalTreeOrder(deviceRecords);
  const projected = wsBorsh.applyLegacyStateSnapshotDiff({ deviceId, session: null }, projection);
  return {
    metadataEpoch: copyBytes(metadataEpoch),
    revision,
    serverEpoch: copyBytes(serverEpoch),
    paneEpochs: paneEpochsFromRecords(deviceRecords),
    treeOrder,
    baseSnapshot: projected,
    snapshot: wsBorsh.sortSnapshotByCanonicalTreeOrder(projected, treeOrder),
  };
}

export function applyMetadataIdentity(
  state: DeviceMetadataState,
  upserts: readonly wsBorsh.SourceMetadataRecord[],
  removals: readonly wsBorsh.SourceEntityKey[]
): MetadataIdentityAction[] {
  const actions: MetadataIdentityAction[] = [];
  const epochChanged = applyServerEpochChange(state, upserts, removals);
  if (epochChanged) actions.push(epochChanged);
  for (const key of removals) {
    const action = applyPaneRemoval(state, key);
    if (action) actions.push(action);
  }
  for (const record of upserts) {
    const action = applyPaneUpsert(state, record);
    if (action) actions.push(action);
  }
  return actions;
}

export function deviceIdsFromMetadataPatch(event: MetadataPatchEvent): Set<string> {
  const deviceIds = new Set<string>();
  for (const record of event.upserts) deviceIds.add(record.key.deviceId);
  for (const key of event.removals) deviceIds.add(key.deviceId);
  return deviceIds;
}

export function metadataPatchMatchesState(
  state: DeviceMetadataState | undefined,
  event: MetadataPatchEvent
): state is DeviceMetadataState {
  return Boolean(
    state &&
      bytesEqual(state.metadataEpoch, event.metadataEpoch) &&
      state.revision === event.fromRevision
  );
}

export function patchRecordsForDevice(
  event: MetadataPatchEvent,
  deviceId: string
): {
  upserts: wsBorsh.SourceMetadataRecord[];
  removals: wsBorsh.SourceEntityKey[];
} {
  return {
    upserts: event.upserts.filter((record) => record.key.deviceId === deviceId),
    removals: event.removals.filter((key) => key.deviceId === deviceId),
  };
}

export function ingestMetadataSnapshot(
  caches: MetadataLiveCaches,
  metadataEpoch: Uint8Array,
  revision: bigint,
  records: readonly wsBorsh.SourceMetadataRecord[]
): boolean {
  let recoveredMetadata = false;
  for (const [deviceId, deviceRecords] of groupRecordsByDevice(records)) {
    const assembled = assembleDeviceMetadata(deviceId, metadataEpoch, revision, deviceRecords);
    if (!assembled) continue;
    const previous = caches.metadata.get(deviceId);
    if (previous && !bytesEqual(previous.serverEpoch, assembled.serverEpoch)) {
      caches.clearPaneStateForDevice(deviceId);
    }
    caches.metadata.set(deviceId, assembled);
    const recoveredEpoch = caches.epochRecoveryDevices.delete(deviceId);
    recoveredMetadata ||= caches.awaitingMetadataDevices.has(deviceId) || recoveredEpoch;
    if (recoveredEpoch) caches.resolvedSubscriptionRetry();
    caches.resolvedRecovery(deviceId);
    caches.awaitingMetadataDevices.delete(deviceId);
    caches.emitSnapshot(assembled.snapshot);
  }
  return recoveredMetadata;
}

export function ingestMetadataPatch(
  caches: MetadataLiveCaches,
  event: MetadataPatchEvent
): 'global-gap' | 'applied' {
  if (event.throughRevision < event.fromRevision) return 'global-gap';
  for (const deviceId of deviceIdsFromMetadataPatch(event)) {
    const state = caches.metadata.get(deviceId);
    if (!metadataPatchMatchesState(state, event)) {
      caches.emitMetadataGap(deviceId);
      continue;
    }
    const { upserts, removals } = patchRecordsForDevice(event, deviceId);
    const projection = wsBorsh.sourceMetadataPatchToLegacyDiff({ ...event, upserts, removals });
    for (const action of applyMetadataIdentity(state, upserts, removals)) {
      realizeIdentityAction(caches, action);
    }
    wsBorsh.applyCanonicalTreeOrderPatch(state.treeOrder, upserts, removals);
    state.revision = event.throughRevision;
    // diff 落在未排序底稿上，展示顺序每次由底稿重算：顺序被 Unset 时才能退回 tmux index 顺序。
    // 顺序在客户端算完再下发整棵快照：消费方若自己再 apply 一次 diff，会掉回 tmux index 顺序
    state.baseSnapshot = wsBorsh.applyLegacyStateSnapshotDiff(state.baseSnapshot, projection);
    state.snapshot = wsBorsh.sortSnapshotByCanonicalTreeOrder(state.baseSnapshot, state.treeOrder);
    caches.emitPatch(deviceId, state.snapshot);
  }
  return 'applied';
}

export function decidePaneData(
  event: PaneDataEvent,
  input: {
    blocked: boolean;
    awaitingMetadata: boolean;
    device: DeviceMetadataState | undefined;
    cursor: wsBorsh.CanonicalTerminalCursor | undefined;
  }
): PaneDataDecision {
  if (input.blocked || input.awaitingMetadata) return { kind: 'ignore' };
  const knownPaneEpoch = input.device?.paneEpochs.get(event.pane.paneId);
  if (!input.device || !knownPaneEpoch) return { kind: 'metadata-gap' };
  if (!bytesEqual(input.device.serverEpoch, event.pane.serverEpoch)) {
    return { kind: 'rebase', reason: 'epoch_changed' };
  }
  if (!bytesEqual(knownPaneEpoch, event.paneEpoch)) {
    return { kind: 'rebase', reason: 'epoch_changed' };
  }
  const cursor = input.cursor;
  if (cursor && !bytesEqual(cursor.paneEpoch, event.paneEpoch)) {
    return { kind: 'rebase', reason: 'epoch_changed' };
  }
  let seqStart = event.seqStart;
  let data = event.data;
  if (cursor) {
    if (seqStart > cursor.terminalSeq) return { kind: 'rebase', reason: 'pane_gap' };
    if (event.seqEnd <= cursor.terminalSeq) return { kind: 'ignore' };
    if (seqStart < cursor.terminalSeq) {
      data = data.subarray(Number(cursor.terminalSeq - seqStart));
      seqStart = cursor.terminalSeq;
    }
  }
  return { kind: 'emit', seqStart, data };
}

export function plannedSubscriptions(
  desired: Map<string, DesiredSubscriptions>,
  metadata: Map<string, DeviceMetadataState>,
  terminalCursors: Map<string, wsBorsh.CanonicalTerminalCursor>,
  skipDevices: ReadonlySet<string>
): {
  activePanes: wsBorsh.CanonicalPaneSubscription[];
  fingerprint: string;
  identityFingerprint: string;
} {
  const activePanes: wsBorsh.CanonicalPaneSubscription[] = [];
  for (const [deviceId, item] of [...desired].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (skipDevices.has(deviceId)) continue;
    const device = metadata.get(deviceId);
    for (const paneId of item.paneIds) {
      const cursor = terminalCursors.get(paneKey(deviceId, paneId));
      activePanes.push({
        pane: {
          deviceId,
          serverEpoch: copyBytes(device?.serverEpoch ?? ZERO_EPOCH),
          paneId,
        },
        cursor: cursor
          ? { paneEpoch: copyBytes(cursor.paneEpoch), terminalSeq: cursor.terminalSeq }
          : null,
      });
    }
  }
  return {
    activePanes,
    fingerprint: activePanes
      .map(
        ({ pane, cursor }) =>
          `${pane.deviceId}\0${pane.paneId}\0${bytesKey(pane.serverEpoch)}\0${cursor ? `${bytesKey(cursor.paneEpoch)}:${cursor.terminalSeq}` : '-'}`
      )
      .join('\u0001'),
    identityFingerprint: activePanes
      .map(({ pane }) => `${pane.deviceId}\0${pane.paneId}\0${bytesKey(pane.serverEpoch)}`)
      .join('\u0001'),
  };
}

export function shouldSkipSubscriptionSend(
  force: boolean,
  wireGeneration: bigint,
  fingerprint: string,
  identityFingerprint: string,
  lastFingerprint: string | null,
  lastIdentityFingerprint: string | null
): boolean {
  if (force || wireGeneration === 0n) return false;
  return identityFingerprint === lastIdentityFingerprint || fingerprint === lastFingerprint;
}

export function deletePrefixedPaneKeys(
  collection: { keys(): IterableIterator<string>; delete(key: string): unknown },
  deviceId: string
): void {
  const prefix = `${deviceId}\0`;
  for (const key of [...collection.keys()]) {
    if (key.startsWith(prefix)) collection.delete(key);
  }
}

export function applySubscriptionRejections(
  rejections: readonly GatewaySubscriptionRejection[],
  terminalCursors: Map<string, wsBorsh.CanonicalTerminalCursor>,
  blockedPanes: Set<string>,
  hasDevice: (deviceId: string) => boolean,
  dropPendingPane: (deviceId: string, paneId: string) => void
): [Set<string>, boolean] {
  const epochChangedDevices = new Set<string>();
  let resourceExhausted = false;
  for (const rejection of rejections) {
    const key = paneKey(rejection.deviceId, rejection.paneId);
    terminalCursors.delete(key);
    if (rejection.reason === 'not_found') {
      blockedPanes.delete(key);
      dropPendingPane(rejection.deviceId, rejection.paneId);
      continue;
    }
    blockedPanes.add(key);
    if (rejection.reason === 'resource_exhausted') resourceExhausted = true;
    else if (hasDevice(rejection.deviceId)) epochChangedDevices.add(rejection.deviceId);
  }
  return [epochChangedDevices, resourceExhausted];
}

function applyServerEpochChange(
  state: DeviceMetadataState,
  upserts: readonly wsBorsh.SourceMetadataRecord[],
  removals: readonly wsBorsh.SourceEntityKey[]
): MetadataIdentityAction | null {
  const nextServerEpoch = upserts[0]?.key.serverEpoch ?? removals[0]?.serverEpoch;
  if (!nextServerEpoch || bytesEqual(state.serverEpoch, nextServerEpoch)) return null;
  state.serverEpoch = copyBytes(nextServerEpoch);
  state.paneEpochs.clear();
  return {
    kind: 'server-epoch-changed',
    deviceId: upserts[0]?.key.deviceId ?? removals[0]?.deviceId ?? '',
  };
}

function applyPaneRemoval(
  state: DeviceMetadataState,
  key: wsBorsh.SourceEntityKey
): MetadataIdentityAction | null {
  if (key.entityKind !== wsBorsh.SOURCE_ENTITY_PANE) return null;
  state.paneEpochs.delete(key.nativeId);
  return { kind: 'pane-removed', deviceId: key.deviceId, paneId: key.nativeId };
}

function applyPaneUpsert(
  state: DeviceMetadataState,
  record: wsBorsh.SourceMetadataRecord
): MetadataIdentityAction | null {
  if (record.key.entityKind !== wsBorsh.SOURCE_ENTITY_PANE) return null;
  const field = record.fields.find((item) => item.field === wsBorsh.SOURCE_FIELD_PANE_EPOCH);
  if (!field) return null;
  const deviceId = record.key.deviceId;
  const paneId = record.key.nativeId;
  if ('Bytes16' in field.value) {
    const previous = state.paneEpochs.get(paneId);
    const changed = Boolean(previous && !bytesEqual(previous, field.value.Bytes16));
    state.paneEpochs.set(paneId, copyBytes(field.value.Bytes16));
    return changed ? { kind: 'pane-epoch-changed', deviceId, paneId } : null;
  }
  if ('Unset' in field.value) {
    state.paneEpochs.delete(paneId);
    return { kind: 'pane-epoch-unset', deviceId, paneId };
  }
  return null;
}

function realizeIdentityAction(caches: MetadataLiveCaches, action: MetadataIdentityAction): void {
  if (action.kind === 'server-epoch-changed') {
    caches.clearPaneStateForDevice(action.deviceId);
    return;
  }
  const key = paneKey(action.deviceId, action.paneId);
  caches.terminalCursors.delete(key);
  if (action.kind === 'pane-removed') {
    caches.blockedPanes.delete(key);
    caches.cancelPane(action.deviceId, action.paneId);
    caches.dropPendingPane(action.deviceId, action.paneId);
    caches.dropSizeEpoch(action.deviceId, action.paneId);
  } else if (action.kind === 'pane-epoch-changed') {
    caches.blockedPanes.add(key);
  }
}
