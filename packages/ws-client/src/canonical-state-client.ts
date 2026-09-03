import { wsBorsh } from '@tmex/shared';
import { CanonicalContentRetry } from './canonical-content-retry';
import {
  CanonicalContentTransactions,
  type PendingContentRequest,
} from './canonical-content-transactions';
import { CanonicalMetadataOverlay } from './canonical-metadata-overlay';
import { CanonicalMetadataRecovery } from './canonical-metadata-recovery';
import { CanonicalPendingCommands } from './canonical-pending-commands';
import {
  type CanonicalEvent,
  type DesiredSubscriptions,
  type DeviceMetadataState,
  MAX_METADATA_ASSEMBLIES,
  MAX_METADATA_CHUNKS,
  type MetadataPatchEvent,
  type MetadataSnapshotAssembly,
  type MetadataSnapshotEvent,
  type PaneDataEvent,
  type SubscriptionAppliedEvent,
  ZERO_EPOCH,
  bytesEqual,
  bytesKey,
  clonePendingCommand,
  copyBytes,
  discardSupersededMetadataAssemblies,
  inputByteGroups,
  mergeSendResult,
  paneEpochsFromRecords,
  paneKey,
  rejectionReason,
  sourceGapReason,
  subscriptionAppliedEvents,
} from './canonical-state-helpers';
import { CanonicalSubscriptionRetry } from './canonical-subscription-retry';
import type { ClientSendResult } from './client';
import { encodeCanonicalGatewayCommand } from './transport-command-encoder';
import type {
  EncodedGatewayCommand,
  GatewayRebaseReason,
  GatewaySubscriptionRejection,
  GatewayTransportCommand,
  GatewayTransportEventHandler,
} from './transport-types';

export interface CanonicalStateClientOptions {
  emit: GatewayTransportEventHandler;
  send: (message: EncodedGatewayCommand) => ClientSendResult;
  effectiveMaxFrameBytes: () => number;
  createId?: () => Uint8Array;
  maxPendingBytes?: number;
  maxPendingFrames?: number;
  onMetadataGap?: () => void;
  metadataRecoveryDelayMs?: number;
  subscriptionRetryMs?: number;
}

function newId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

export class CanonicalStateClient {
  private readonly desired = new Map<string, DesiredSubscriptions>();
  private readonly metadata = new Map<string, DeviceMetadataState>();
  private readonly metadataAssemblies = new Map<string, MetadataSnapshotAssembly>();
  private readonly terminalCursors = new Map<string, wsBorsh.CanonicalTerminalCursor>();
  private readonly blockedPanes = new Set<string>();
  private readonly awaitingMetadataDevices = new Set<string>();
  private readonly content: CanonicalContentTransactions;
  private readonly contentRetry: CanonicalContentRetry;
  private readonly overlays = new CanonicalMetadataOverlay();
  private readonly metadataRecovery: CanonicalMetadataRecovery;
  private readonly subscriptionRetry: CanonicalSubscriptionRetry;
  private readonly pending: CanonicalPendingCommands;
  private active = false;
  private wireGeneration = 0n;
  private latestSubscriptionGeneration = 0n;
  private lastSubscriptionFingerprint: string | null = null;
  private lastSubscriptionIdentityFingerprint: string | null = null;
  private feedMaxFrameBytes: number | null = null;
  private gatewayEpoch: Uint8Array | null = null;
  private readonly createId: () => Uint8Array;
  private readonly maxPendingBytes: number;
  private readonly maxPendingFrames: number;

  constructor(private readonly options: CanonicalStateClientOptions) {
    this.createId = options.createId ?? newId;
    this.maxPendingBytes = options.maxPendingBytes ?? 2 * 1024 * 1024;
    this.maxPendingFrames = options.maxPendingFrames ?? 2_048;
    this.pending = new CanonicalPendingCommands(
      options.emit,
      this.maxPendingBytes,
      this.maxPendingFrames
    );
    this.metadataRecovery = new CanonicalMetadataRecovery(
      options.onMetadataGap,
      options.metadataRecoveryDelayMs
    );
    this.subscriptionRetry = new CanonicalSubscriptionRetry(options.subscriptionRetryMs);
    this.contentRetry = new CanonicalContentRetry({
      retry: (request) => {
        if (this.active) this.sendCanonicalCommand(request.command, true);
        else this.deferTargetCommand(request.command, true);
      },
      exhausted: (request) =>
        this.emitPaneRebase(request.deviceId, request.paneId, 'resource_exhausted'),
    });
    this.content = new CanonicalContentTransactions({
      emit: options.emit,
      acceptPane: (deviceId, paneId, serverEpoch, paneEpoch) => {
        const device = this.metadata.get(deviceId);
        const currentPaneEpoch = device?.paneEpochs.get(paneId);
        return Boolean(
          device &&
            bytesEqual(device.serverEpoch, serverEpoch) &&
            currentPaneEpoch &&
            bytesEqual(currentPaneEpoch, paneEpoch)
        );
      },
      onCommitted: (kind, deviceId, paneId) => this.contentRetry.complete(kind, deviceId, paneId),
      onRebase: (deviceId, paneId, reason) => this.emitPaneRebase(deviceId, paneId, reason),
      onScreenCursor: (deviceId, paneId, paneEpoch, terminalSeq) => {
        const key = paneKey(deviceId, paneId);
        this.terminalCursors.set(key, { paneEpoch: copyBytes(paneEpoch), terminalSeq });
        this.blockedPanes.delete(key);
        this.metadata.get(deviceId)?.paneEpochs.set(paneId, copyBytes(paneEpoch));
      },
    });
  }

  activate(): ClientSendResult {
    this.active = true;
    this.blockedPanes.clear();
    this.wireGeneration = 0n;
    this.latestSubscriptionGeneration = 0n;
    this.lastSubscriptionFingerprint = null;
    this.lastSubscriptionIdentityFingerprint = null;
    this.subscriptionRetry.resolved();
    this.resetConnectionAssemblies();
    for (const deviceId of this.metadata.keys()) this.awaitingMetadataDevices.add(deviceId);
    return this.sendSubscriptions(true);
  }

  suspend(): void {
    this.active = false;
    const retry = this.content.pendingRequests();
    this.subscriptionRetry.resolved();
    this.resetConnectionAssemblies();
    for (const request of retry) this.deferTargetCommand(request.command, true);
  }

  dispose(): void {
    this.suspend();
    this.desired.clear();
    this.metadata.clear();
    this.terminalCursors.clear();
    this.blockedPanes.clear();
    this.pending.clear();
    this.contentRetry.dispose();
  }

  handles(command: GatewayTransportCommand): boolean {
    return (
      command.type === 'set-pane-subscriptions' ||
      command.type === 'terminal-input' ||
      command.type === 'terminal-paste' ||
      command.type === 'terminal-resize' ||
      command.type === 'terminal-sync-size' ||
      command.type === 'request-pane-screen' ||
      command.type === 'request-pane-history'
    );
  }

  sendCommand(command: GatewayTransportCommand): ClientSendResult | null {
    if (!this.active || !this.handles(command)) return null;
    return this.sendCanonicalCommand(command, true);
  }

  stageCommand(command: GatewayTransportCommand): void {
    if (command.type === 'set-pane-subscriptions') {
      this.updateDesiredSubscriptions(command.deviceId, command.paneIds);
    } else if (command.type === 'disconnect-device') {
      this.desired.delete(command.deviceId);
      this.metadata.delete(command.deviceId);
      this.awaitingMetadataDevices.delete(command.deviceId);
      this.metadataRecovery.resolved(command.deviceId);
      this.clearPaneStateForDevice(command.deviceId);
      this.dropPendingCommandsForDevice(command.deviceId);
    }
  }

  removeDevice(deviceId: string): ClientSendResult {
    this.desired.delete(deviceId);
    this.metadata.delete(deviceId);
    this.awaitingMetadataDevices.delete(deviceId);
    this.metadataRecovery.resolved(deviceId);
    this.clearPaneStateForDevice(deviceId);
    this.dropPendingCommandsForDevice(deviceId);
    return this.active ? this.sendSubscriptions(true) : 'sent';
  }

  takePendingCommands(): GatewayTransportCommand[] {
    return this.pending.takeAll();
  }

  handleEventPayload(payload: Uint8Array): void {
    this.handleEvent(wsBorsh.decodeCanonicalEventPayload(payload).event);
  }

  handleLegacyOverlaySnapshot(payload: Uint8Array): void {
    const snapshot = wsBorsh.decodeStateSnapshot(payload);
    this.overlays.capture(snapshot);
    const state = this.metadata.get(snapshot.deviceId);
    if (!state) return;
    state.snapshot = this.overlays.apply(state.snapshot);
    this.options.emit({ type: 'metadata-snapshot', snapshot: state.snapshot });
  }

  handleEvent(event: CanonicalEvent): void {
    if ('FeedReady' in event) {
      this.handleFeedReady(event.FeedReady);
    } else if ('SourceMetadataSnapshot' in event) {
      this.handleMetadataSnapshot(event.SourceMetadataSnapshot);
    } else if ('SourceMetadataPatch' in event) {
      this.handleMetadataPatch(event.SourceMetadataPatch);
    } else if ('PaneData' in event) {
      this.handlePaneData(event.PaneData);
    } else if ('SubscriptionApplied' in event) {
      this.handleSubscriptionApplied(event.SubscriptionApplied);
    } else if ('ScreenBegin' in event) {
      this.content.beginScreen(event.ScreenBegin);
    } else if ('ScreenChunk' in event) {
      this.content.appendScreen(event.ScreenChunk);
    } else if ('ScreenCommit' in event) {
      this.content.commitScreen(event.ScreenCommit);
    } else if ('HistoryBegin' in event) {
      this.content.beginHistory(event.HistoryBegin);
    } else if ('HistoryChunk' in event) {
      this.content.appendHistory(event.HistoryChunk);
    } else if ('HistoryCommit' in event) {
      this.content.commitHistory(event.HistoryCommit);
    } else if ('SourceGap' in event) {
      this.handleSourceGap(event.SourceGap);
    } else if ('Error' in event) {
      this.handleCanonicalError(event.Error);
    }
  }

  private sendCanonicalCommand(
    command: GatewayTransportCommand,
    allowQueue: boolean
  ): ClientSendResult | null {
    if (command.type === 'set-pane-subscriptions') {
      this.updateDesiredSubscriptions(command.deviceId, command.paneIds);
      return this.sendSubscriptions(true);
    }
    if (command.type === 'terminal-input') {
      if (command.isComposing) return 'sent';
      return this.sendInput(command, allowQueue);
    }
    if (command.type === 'terminal-paste') return this.sendInput(command, allowQueue);
    if (command.type === 'terminal-resize' || command.type === 'terminal-sync-size') {
      return this.sendResize(command, allowQueue);
    }
    if (command.type === 'request-pane-screen') return this.sendScreen(command, allowQueue);
    if (command.type === 'request-pane-history') return this.sendHistory(command, allowQueue);
    return null;
  }

  private sendSubscriptions(force = false): ClientSendResult {
    const activePanes: wsBorsh.CanonicalPaneSubscription[] = [];
    for (const [deviceId, desired] of [...this.desired].sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      const device = this.metadata.get(deviceId);
      for (const paneId of desired.paneIds) {
        const key = paneKey(deviceId, paneId);
        const cursor = this.terminalCursors.get(key);
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
    const fingerprint = activePanes
      .map(
        ({ pane, cursor }) =>
          `${pane.deviceId}\0${pane.paneId}\0${bytesKey(pane.serverEpoch)}\0${cursor ? `${bytesKey(cursor.paneEpoch)}:${cursor.terminalSeq}` : '-'}`
      )
      .join('\u0001');
    const identityFingerprint = activePanes
      .map(({ pane }) => `${pane.deviceId}\0${pane.paneId}\0${bytesKey(pane.serverEpoch)}`)
      .join('\u0001');
    if (
      !force &&
      identityFingerprint === this.lastSubscriptionIdentityFingerprint &&
      this.wireGeneration > 0n
    ) {
      return 'sent';
    }
    if (!force && fingerprint === this.lastSubscriptionFingerprint && this.wireGeneration > 0n) {
      return 'sent';
    }
    this.wireGeneration += 1n;
    const result = this.send({
      SetPaneSubscriptions: {
        generation: this.wireGeneration,
        activePanes,
        hotPanes: [],
      },
    });
    if (result !== 'overflow') {
      this.lastSubscriptionFingerprint = fingerprint;
      this.lastSubscriptionIdentityFingerprint = identityFingerprint;
    }
    return result;
  }

  private updateDesiredSubscriptions(deviceId: string, paneIds: readonly string[]): void {
    const panes = [...new Set(paneIds)].sort();
    if (panes.length === 0) this.desired.delete(deviceId);
    else this.desired.set(deviceId, { paneIds: panes });
  }

  private sendInput(
    command: Extract<GatewayTransportCommand, { type: 'terminal-input' | 'terminal-paste' }>,
    allowQueue: boolean
  ): ClientSendResult {
    const target = this.resolveTarget(command.deviceId, command.paneId);
    const paneEpoch = this.resolvePaneEpoch(command.deviceId, command.paneId);
    if (!target || !paneEpoch) return this.deferTargetCommand(command, allowQueue);
    const frameLimit = this.canonicalFrameLimit();
    const empty = wsBorsh.encodeCanonicalCommandPayload({
      TerminalInput: {
        requestId: new Uint8Array(16),
        pane: target,
        paneEpoch,
        inputId: new Uint8Array(16),
        data: new Uint8Array(),
      },
    });
    const maxDataBytes = frameLimit - wsBorsh.WS_ENVELOPE_WIRE_OVERHEAD_BYTES - empty.byteLength;
    if (maxDataBytes <= 0) return this.failFrameLimit('canonical TerminalInput has no data budget');
    let result: ClientSendResult = 'sent';
    for (const group of inputByteGroups(command)) {
      const chunkCount = Math.max(1, Math.ceil(group.byteLength / maxDataBytes));
      for (let index = 0; index < chunkCount; index += 1) {
        const requestId = this.nextId();
        const inputId = this.nextId();
        const data = group.subarray(index * maxDataBytes, (index + 1) * maxDataBytes);
        result = mergeSendResult(
          result,
          this.send({ TerminalInput: { requestId, pane: target, paneEpoch, inputId, data } })
        );
        if (result === 'overflow') return result;
      }
    }
    return result;
  }

  private sendResize(
    command: Extract<GatewayTransportCommand, { type: 'terminal-resize' | 'terminal-sync-size' }>,
    allowQueue: boolean
  ): ClientSendResult {
    const pane = this.resolveTarget(command.deviceId, command.paneId);
    if (!pane) return this.deferTargetCommand(command, allowQueue);
    const requestId = this.nextId();
    return this.send({
      ResizePane: { requestId, pane, rows: command.rows, cols: command.cols },
    });
  }

  private sendScreen(
    command: Extract<GatewayTransportCommand, { type: 'request-pane-screen' }>,
    allowQueue: boolean
  ): ClientSendResult {
    const pane = this.resolveTarget(command.deviceId, command.paneId);
    if (!pane) return this.deferTargetCommand(command, allowQueue);
    this.contentRetry.cancelScheduled('screen', command.deviceId, command.paneId);
    const requestId = copyBytes(command.requestId);
    this.content.rememberRequest(requestId, {
      kind: 'screen',
      deviceId: command.deviceId,
      paneId: command.paneId,
      serverEpoch: copyBytes(pane.serverEpoch),
      command: clonePendingCommand(command) as typeof command,
    });
    return this.send({ RequestScreen: { requestId, pane, byteLimit: command.byteLimit } });
  }

  private sendHistory(
    command: Extract<GatewayTransportCommand, { type: 'request-pane-history' }>,
    allowQueue: boolean
  ): ClientSendResult {
    const pane = this.resolveTarget(command.deviceId, command.paneId);
    if (!pane) return this.deferTargetCommand(command, allowQueue);
    this.contentRetry.cancelScheduled('history', command.deviceId, command.paneId);
    const requestId = copyBytes(command.requestId);
    this.content.rememberRequest(requestId, {
      kind: 'history',
      deviceId: command.deviceId,
      paneId: command.paneId,
      serverEpoch: copyBytes(pane.serverEpoch),
      command: clonePendingCommand(command) as typeof command,
    });
    return this.send({
      RequestHistory: {
        requestId,
        pane,
        beforeCursor: command.cursor
          ? {
              paneEpoch: copyBytes(command.cursor.paneEpoch),
              historyEpoch: copyBytes(command.cursor.historyEpoch),
              beforeLine: command.cursor.beforeLine,
            }
          : null,
        byteLimit: command.byteLimit,
      },
    });
  }

  private deferTargetCommand(
    command: GatewayTransportCommand,
    allowQueue: boolean
  ): ClientSendResult {
    return this.pending.enqueue(command, allowQueue);
  }

  private flushTargetCommands(): void {
    this.pending.flush((command) => this.sendCanonicalCommand(command, false));
  }

  private send(command: wsBorsh.CanonicalCommand): ClientSendResult {
    try {
      return this.options.send(encodeCanonicalGatewayCommand(command, this.canonicalFrameLimit()));
    } catch (error) {
      this.options.emit({
        type: 'transport-error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return 'overflow';
    }
  }

  private failFrameLimit(message: string): ClientSendResult {
    this.options.emit({ type: 'transport-error', error: new Error(message) });
    return 'overflow';
  }

  private canonicalFrameLimit(): number {
    return Math.min(
      wsBorsh.CANONICAL_STATE_MAX_FRAME_BYTES,
      this.options.effectiveMaxFrameBytes(),
      this.feedMaxFrameBytes ?? Number.POSITIVE_INFINITY
    );
  }

  private nextId(): Uint8Array {
    const value = this.createId();
    if (value.byteLength !== 16) throw new Error('canonical request id must be 16 bytes');
    return copyBytes(value);
  }

  private resolveTarget(deviceId: string, paneId: string): wsBorsh.CanonicalPaneTarget | null {
    if (this.awaitingMetadataDevices.has(deviceId)) return null;
    const device = this.metadata.get(deviceId);
    if (!device) return null;
    return { deviceId, serverEpoch: copyBytes(device.serverEpoch), paneId };
  }

  private resolvePaneEpoch(deviceId: string, paneId: string): Uint8Array | null {
    const key = paneKey(deviceId, paneId);
    return (
      this.metadata.get(deviceId)?.paneEpochs.get(paneId) ??
      this.terminalCursors.get(key)?.paneEpoch ??
      null
    );
  }

  private handleFeedReady(
    event: Extract<CanonicalEvent, { FeedReady: unknown }>['FeedReady']
  ): void {
    if (this.gatewayEpoch && !bytesEqual(this.gatewayEpoch, event.gatewayEpoch)) {
      const retry = this.content.pendingRequests();
      this.metadataAssemblies.clear();
      this.content.clear();
      for (const deviceId of this.metadata.keys()) this.awaitingMetadataDevices.add(deviceId);
      for (const request of retry) this.deferTargetCommand(request.command, true);
    }
    this.gatewayEpoch = copyBytes(event.gatewayEpoch);
    this.feedMaxFrameBytes = event.maxFrameBytes;
    this.content.setLimits(event.maxScreenBytes, event.maxHistoryPageBytes);
  }

  private handleMetadataSnapshot(event: MetadataSnapshotEvent): void {
    if (
      event.totalChunks === 0 ||
      event.totalChunks > MAX_METADATA_CHUNKS ||
      event.chunkIndex >= event.totalChunks
    ) {
      this.emitMetadataGap();
      return;
    }
    const key = bytesKey(event.snapshotId);
    let assembly = this.metadataAssemblies.get(key);
    if (!assembly) {
      if (this.metadataAssemblies.size >= MAX_METADATA_ASSEMBLIES) {
        this.metadataAssemblies.clear();
        this.emitMetadataGap();
        return;
      }
      assembly = {
        metadataEpoch: copyBytes(event.metadataEpoch),
        revision: event.revision,
        totalChunks: event.totalChunks,
        chunks: new Array(event.totalChunks),
        receivedChunks: 0,
        deviceIds: new Set(),
      };
      this.metadataAssemblies.set(key, assembly);
    } else if (
      !bytesEqual(assembly.metadataEpoch, event.metadataEpoch) ||
      assembly.revision !== event.revision ||
      assembly.totalChunks !== event.totalChunks
    ) {
      this.metadataAssemblies.delete(key);
      this.emitMetadataGap();
      return;
    }
    if (assembly.chunks[event.chunkIndex]) {
      this.metadataAssemblies.delete(key);
      this.emitMetadataGap();
      return;
    }
    for (const record of event.records) assembly.deviceIds.add(record.key.deviceId);
    assembly.chunks[event.chunkIndex] = event.records;
    assembly.receivedChunks += 1;
    if (assembly.receivedChunks !== assembly.totalChunks) return;
    this.metadataAssemblies.delete(key);
    const records = assembly.chunks.flatMap((chunk) => chunk ?? []);
    discardSupersededMetadataAssemblies(this.metadataAssemblies, assembly.deviceIds);
    this.commitMetadataSnapshot(assembly.metadataEpoch, assembly.revision, records);
  }

  private commitMetadataSnapshot(
    metadataEpoch: Uint8Array,
    revision: bigint,
    records: wsBorsh.SourceMetadataRecord[]
  ): void {
    const byDevice = new Map<string, wsBorsh.SourceMetadataRecord[]>();
    for (const record of records) {
      const group = byDevice.get(record.key.deviceId) ?? [];
      group.push(record);
      byDevice.set(record.key.deviceId, group);
    }
    for (const [deviceId, deviceRecords] of byDevice) {
      const serverEpoch = deviceRecords[0]?.key.serverEpoch;
      if (!serverEpoch) continue;
      const diff = wsBorsh.sourceMetadataPatchToLegacyDiff({
        metadataEpoch,
        fromRevision: 0n,
        throughRevision: revision,
        upserts: deviceRecords,
        removals: [],
      });
      const snapshot = this.overlays.apply(
        wsBorsh.applyLegacyStateSnapshotDiff({ deviceId, session: null }, diff)
      );
      const previous = this.metadata.get(deviceId);
      if (previous && !bytesEqual(previous.serverEpoch, serverEpoch)) {
        this.clearPaneStateForDevice(deviceId);
      }
      const paneEpochs = paneEpochsFromRecords(deviceRecords);
      this.metadata.set(deviceId, {
        metadataEpoch: copyBytes(metadataEpoch),
        revision,
        serverEpoch: copyBytes(serverEpoch),
        paneEpochs,
        snapshot,
      });
      this.metadataRecovery.resolved(deviceId);
      this.awaitingMetadataDevices.delete(deviceId);
      this.options.emit({ type: 'metadata-snapshot', snapshot });
    }
    this.sendSubscriptions();
    this.flushTargetCommands();
  }

  private handleMetadataPatch(event: MetadataPatchEvent): void {
    if (event.throughRevision < event.fromRevision) {
      this.emitMetadataGap();
      return;
    }
    const deviceIds = new Set<string>();
    for (const record of event.upserts) deviceIds.add(record.key.deviceId);
    for (const key of event.removals) deviceIds.add(key.deviceId);
    for (const deviceId of deviceIds) {
      const state = this.metadata.get(deviceId);
      if (
        !state ||
        !bytesEqual(state.metadataEpoch, event.metadataEpoch) ||
        state.revision !== event.fromRevision
      ) {
        this.emitMetadataGap(deviceId);
        continue;
      }
      const upserts = event.upserts.filter((record) => record.key.deviceId === deviceId);
      const removals = event.removals.filter((key) => key.deviceId === deviceId);
      const patch = { ...event, upserts, removals };
      const diff = wsBorsh.sourceMetadataPatchToLegacyDiff(patch);
      this.updateMetadataIdentity(state, upserts, removals);
      state.revision = event.throughRevision;
      state.snapshot = this.overlays.apply(
        wsBorsh.applyLegacyStateSnapshotDiff(state.snapshot, diff)
      );
      this.options.emit({ type: 'metadata-patch', deviceId, patch: diff });
    }
    this.sendSubscriptions();
    this.flushTargetCommands();
  }

  private updateMetadataIdentity(
    state: DeviceMetadataState,
    upserts: readonly wsBorsh.SourceMetadataRecord[],
    removals: readonly wsBorsh.SourceEntityKey[]
  ): void {
    const nextServerEpoch = upserts[0]?.key.serverEpoch ?? removals[0]?.serverEpoch;
    if (nextServerEpoch && !bytesEqual(state.serverEpoch, nextServerEpoch)) {
      this.clearPaneStateForDevice(upserts[0]?.key.deviceId ?? removals[0]?.deviceId ?? '');
      state.serverEpoch = copyBytes(nextServerEpoch);
      state.paneEpochs.clear();
    }
    for (const key of removals) {
      if (key.entityKind !== wsBorsh.SOURCE_ENTITY_PANE) continue;
      state.paneEpochs.delete(key.nativeId);
      this.terminalCursors.delete(paneKey(key.deviceId, key.nativeId));
      this.blockedPanes.delete(paneKey(key.deviceId, key.nativeId));
      this.content.cancelPane(key.deviceId, key.nativeId);
      this.dropPendingCommandsForPane(key.deviceId, key.nativeId);
    }
    for (const record of upserts) {
      if (record.key.entityKind !== wsBorsh.SOURCE_ENTITY_PANE) continue;
      const field = record.fields.find((item) => item.field === wsBorsh.SOURCE_FIELD_PANE_EPOCH);
      if (!field) continue;
      const key = paneKey(record.key.deviceId, record.key.nativeId);
      if ('Bytes16' in field.value) {
        const previous = state.paneEpochs.get(record.key.nativeId);
        if (previous && !bytesEqual(previous, field.value.Bytes16)) {
          this.terminalCursors.delete(key);
          this.blockedPanes.add(key);
        }
        state.paneEpochs.set(record.key.nativeId, copyBytes(field.value.Bytes16));
      } else if ('Unset' in field.value) {
        state.paneEpochs.delete(record.key.nativeId);
        this.terminalCursors.delete(key);
      }
    }
  }

  private handlePaneData(event: PaneDataEvent): void {
    const key = paneKey(event.pane.deviceId, event.pane.paneId);
    if (this.blockedPanes.has(key)) return;
    if (this.awaitingMetadataDevices.has(event.pane.deviceId)) return;
    const device = this.metadata.get(event.pane.deviceId);
    const knownPaneEpoch = device?.paneEpochs.get(event.pane.paneId);
    if (!device || !knownPaneEpoch) {
      this.emitMetadataGap(event.pane.deviceId);
      return;
    }
    if (!bytesEqual(device.serverEpoch, event.pane.serverEpoch)) {
      this.emitPaneRebase(event.pane.deviceId, event.pane.paneId, 'epoch_changed');
      return;
    }
    if (!bytesEqual(knownPaneEpoch, event.paneEpoch)) {
      this.emitPaneRebase(event.pane.deviceId, event.pane.paneId, 'epoch_changed');
      return;
    }
    const cursor = this.terminalCursors.get(key);
    if (cursor && !bytesEqual(cursor.paneEpoch, event.paneEpoch)) {
      this.emitPaneRebase(event.pane.deviceId, event.pane.paneId, 'epoch_changed');
      return;
    }
    let seqStart = event.seqStart;
    let data = event.data;
    if (cursor) {
      if (seqStart > cursor.terminalSeq) {
        this.emitPaneRebase(event.pane.deviceId, event.pane.paneId, 'pane_gap');
        return;
      }
      if (event.seqEnd <= cursor.terminalSeq) return;
      if (seqStart < cursor.terminalSeq) {
        const offset = Number(cursor.terminalSeq - seqStart);
        data = data.subarray(offset);
        seqStart = cursor.terminalSeq;
      }
    }
    this.terminalCursors.set(key, {
      paneEpoch: copyBytes(event.paneEpoch),
      terminalSeq: event.seqEnd,
    });
    this.options.emit({
      type: 'terminal-data',
      frame: {
        deviceId: event.pane.deviceId,
        paneId: event.pane.paneId,
        paneEpoch: copyBytes(event.paneEpoch),
        seqStart,
        seqEnd: event.seqEnd,
        data,
      },
    });
  }

  private handleSubscriptionApplied(event: SubscriptionAppliedEvent): void {
    if (
      event.generation < this.latestSubscriptionGeneration ||
      event.generation < this.wireGeneration
    ) {
      return;
    }
    this.latestSubscriptionGeneration = event.generation;
    this.wireGeneration = event.generation;
    const rejections: GatewaySubscriptionRejection[] = event.rejected.map((item) => ({
      deviceId: item.pane.deviceId,
      paneId: item.pane.paneId,
      reason: rejectionReason(item.reason),
    }));
    for (const applied of subscriptionAppliedEvents(event, rejections)) this.options.emit(applied);
    for (const pane of [...event.activePanes, ...event.hotPanes]) {
      const key = paneKey(pane.deviceId, pane.paneId);
      if (this.terminalCursors.has(key) || this.blockedPanes.has(key)) continue;
      this.blockedPanes.add(key);
      this.options.emit({
        type: 'rebase-required',
        deviceId: pane.deviceId,
        paneId: pane.paneId,
        reason: 'cache_evicted',
      });
    }
    let retry = false;
    let resourceExhausted = false;
    for (const rejection of rejections) {
      const key = paneKey(rejection.deviceId, rejection.paneId);
      this.terminalCursors.delete(key);
      if (rejection.reason === 'not_found') {
        this.blockedPanes.delete(key);
        this.dropPendingCommandsForPane(rejection.deviceId, rejection.paneId);
        continue;
      }
      this.blockedPanes.add(key);
      if (rejection.reason === 'resource_exhausted') {
        resourceExhausted = true;
        continue;
      }
      if (rejection.reason === 'epoch_changed' && this.metadata.has(rejection.deviceId)) {
        this.blockedPanes.add(key);
        retry = true;
      }
    }
    if (retry && event.generation === this.wireGeneration) {
      this.lastSubscriptionFingerprint = null;
      this.sendSubscriptions(true);
    }
    if (resourceExhausted) {
      this.subscriptionRetry.request(() => {
        if (!this.active) return;
        this.lastSubscriptionFingerprint = null;
        this.sendSubscriptions(true);
      });
    } else {
      this.subscriptionRetry.resolved();
    }
  }

  private handleSourceGap(gap: Extract<CanonicalEvent, { SourceGap: unknown }>['SourceGap']): void {
    if ('Pane' in gap.scope) {
      const pane = gap.scope.Pane.pane;
      const retry = this.content
        .pendingRequests()
        .filter((request) => request.deviceId === pane.deviceId && request.paneId === pane.paneId);
      this.metadata
        .get(pane.deviceId)
        ?.paneEpochs.set(pane.paneId, copyBytes(gap.scope.Pane.availablePaneEpoch));
      this.emitPaneRebase(
        pane.deviceId,
        pane.paneId,
        sourceGapReason(gap.reason, 'pane_gap') === 'metadata_gap'
          ? 'pane_gap'
          : sourceGapReason(gap.reason, 'pane_gap')
      );
      this.lastSubscriptionFingerprint = null;
      this.sendSubscriptions(true);
      this.retryContentRequests(retry);
      return;
    }
    if ('Metadata' in gap.scope) {
      this.metadataAssemblies.clear();
      this.emitMetadataGap();
      return;
    }
    const retry = this.content.pendingRequests();
    this.content.clear();
    this.terminalCursors.clear();
    for (const [deviceId, desired] of this.desired) {
      for (const paneId of desired.paneIds) this.blockedPanes.add(paneKey(deviceId, paneId));
    }
    const reason = sourceGapReason(gap.reason, 'pane_gap');
    if (reason === 'metadata_gap') this.options.emit({ type: 'rebase-required', reason });
    this.options.emit({
      type: 'rebase-required',
      reason: reason === 'metadata_gap' ? 'pane_gap' : reason,
    });
    this.lastSubscriptionFingerprint = null;
    this.sendSubscriptions(true);
    this.retryContentRequests(retry);
  }

  private handleCanonicalError(event: Extract<CanonicalEvent, { Error: unknown }>['Error']): void {
    const request = this.content.takeFailedRequest(event.requestId);
    const error = new Error(`[canonical ${event.code}] ${event.message}`);
    Object.assign(error, {
      code: event.code,
      retryable: event.retryable,
      requestId: event.requestId,
    });
    this.options.emit({ type: 'transport-error', error });
    if (!request || !event.retryable) return;
    if (request.kind === 'screen') this.contentRetry.schedule(request);
    else this.emitPaneRebase(request.deviceId, request.paneId, 'cache_evicted');
  }

  private emitPaneRebase(deviceId: string, paneId: string, reason: GatewayRebaseReason): void {
    const key = paneKey(deviceId, paneId);
    this.blockedPanes.add(key);
    this.terminalCursors.delete(key);
    this.content.cancelPane(deviceId, paneId);
    this.contentRetry.clearPane(deviceId, paneId);
    this.options.emit({ type: 'rebase-required', deviceId, paneId, reason });
  }

  private emitMetadataGap(deviceId?: string): void {
    if (deviceId) this.awaitingMetadataDevices.add(deviceId);
    else
      for (const knownDeviceId of this.metadata.keys())
        this.awaitingMetadataDevices.add(knownDeviceId);
    this.options.emit({ type: 'rebase-required', reason: 'metadata_gap' });
    this.metadataRecovery.request(deviceId);
  }

  private retryContentRequests(requests: readonly PendingContentRequest[]): void {
    for (const request of requests) {
      if (this.content.hasPending(request.kind, request.deviceId, request.paneId)) continue;
      this.sendCanonicalCommand(request.command, true);
    }
  }

  private clearPaneStateForDevice(deviceId: string): void {
    const prefix = `${deviceId}\0`;
    for (const key of this.terminalCursors.keys()) {
      if (key.startsWith(prefix)) this.terminalCursors.delete(key);
    }
    for (const key of this.blockedPanes) {
      if (key.startsWith(prefix)) this.blockedPanes.delete(key);
    }
  }

  private dropPendingCommandsForDevice(deviceId: string): void {
    this.pending.dropDevice(deviceId);
  }

  private dropPendingCommandsForPane(deviceId: string, paneId: string): void {
    this.pending.dropPane(deviceId, paneId);
  }

  private resetConnectionAssemblies(): void {
    this.metadataAssemblies.clear();
    this.awaitingMetadataDevices.clear();
    this.content.reset();
    this.metadataRecovery.reset();
    this.feedMaxFrameBytes = null;
    this.gatewayEpoch = null;
  }
}
