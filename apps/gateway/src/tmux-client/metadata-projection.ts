import { type StateSnapshotPayload, wsBorsh } from '@tmex/shared';

import type { TmuxSourceMetadataEvent } from './events';
import { MetadataEventApplier } from './metadata/event-applier';
import { MetadataHierarchyBuilder } from './metadata/hierarchy-builder';
import { MetadataPatchBuffer } from './metadata/patch-buffer';
import {
  type MetadataReconcileAction,
  buildMetadataReconcilePlan,
} from './metadata/reconcile-plan';
import {
  MAX_UNKNOWN_PANES,
  MAX_UNKNOWN_PANE_BYTES,
  type MetadataProjectionOptions,
  type MetadataProjectionPatch,
  type MetadataProjectionSnapshot,
  type MetadataValue,
  type PaneFieldHints,
  type ProjectedRecord,
  bytesEqual,
  cloneKey,
  cloneValue,
  copyBytes,
  createRecord,
  defaultCreateEpoch,
  keyEqual,
  keyId,
  stringValue,
  toWireRecord,
  valueEqual,
} from './metadata/types';

export type { MetadataProjectionOptions, MetadataProjectionPatch, MetadataProjectionSnapshot };

export class MetadataProjection {
  private metadataEpochValue: Uint8Array;
  private serverEpochValue: Uint8Array | null = null;
  private revisionValue = 0n;
  private readonly records = new Map<string, ProjectedRecord>();
  private readonly removedAt = new Map<string, bigint>();
  private readonly paneEpochs = new Map<string, Uint8Array>();
  private readonly unknownPaneHints = new Map<string, PaneFieldHints>();
  private unknownPaneBytes = 0;
  private readonly windowCustomNames = new Map<string, string>();
  private readonly paneCustomNames = new Map<string, string>();
  private established = false;
  private disposed = false;
  private readonly deviceName: string;
  private readonly createEpoch: () => Uint8Array;
  private readonly onRebaseRequired?: MetadataProjectionOptions['onRebaseRequired'];
  private readonly hierarchy: MetadataHierarchyBuilder;
  private readonly eventApplier: MetadataEventApplier;
  private readonly patchBuffer: MetadataPatchBuffer;

  constructor(
    readonly deviceId: string,
    options: MetadataProjectionOptions = {}
  ) {
    this.deviceName = options.deviceName?.trim() || deviceId;
    this.createEpoch = options.createEpoch ?? defaultCreateEpoch;
    this.onRebaseRequired = options.onRebaseRequired;
    this.metadataEpochValue = copyBytes(this.createEpoch());
    this.hierarchy = new MetadataHierarchyBuilder({
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      getServerEpoch: () => this.serverEpochValue,
      getWindowCustomName: (windowId) => this.windowCustomNames.get(windowId),
      getPaneCustomName: (paneId) => this.paneCustomNames.get(paneId),
      ensurePaneEpoch: (paneId) => this.ensurePaneEpoch(paneId),
      takeUnknownPaneHints: (paneId) => {
        const hints = this.unknownPaneHints.get(paneId);
        if (hints) this.deleteUnknownPane(paneId);
        return hints;
      },
    });
    this.eventApplier = new MetadataEventApplier({
      records: this.records,
      rememberUnknownPane: (paneId, fields) => this.rememberUnknownPane(paneId, fields),
      setRecordField: (record, field, value, revision) =>
        this.setRecordField(record, field, value, revision),
      removeRecord: (record, revision) => this.removeRecord(record, revision),
    });
    this.patchBuffer = new MetadataPatchBuffer({
      flushIntervalMs: options.flushIntervalMs,
      getMetadataEpoch: () => this.metadataEpoch,
      getRevision: () => this.revisionValue,
      currentSnapshot: () => this.currentSnapshot(),
      onPatch: options.onPatch,
      onRebaseRequired: options.onRebaseRequired,
    });
  }

  get revision(): bigint {
    return this.revisionValue;
  }

  get metadataEpoch(): Uint8Array {
    return copyBytes(this.metadataEpochValue);
  }

  get serverEpoch(): Uint8Array | null {
    return this.serverEpochValue ? copyBytes(this.serverEpochValue) : null;
  }

  getPaneEpoch(paneId: string): Uint8Array | null {
    const paneEpoch = this.paneEpochs.get(paneId);
    return paneEpoch ? copyBytes(paneEpoch) : null;
  }

  ensurePaneEpoch(paneId: string): Uint8Array | null {
    if (!this.serverEpochValue) return null;
    const existing = this.paneEpochs.get(paneId);
    if (existing) return copyBytes(existing);
    const paneEpoch = copyBytes(this.createEpoch());
    this.paneEpochs.set(paneId, paneEpoch);
    return copyBytes(paneEpoch);
  }

  hasPane(paneId: string): boolean {
    return this.records.has(keyId({ entityKind: wsBorsh.SOURCE_ENTITY_PANE, nativeId: paneId }));
  }

  setServerEpoch(serverEpoch: Uint8Array): void {
    if (this.disposed) return;
    if (serverEpoch.byteLength !== 16) throw new Error('server epoch must be 16 bytes');
    if (this.serverEpochValue && bytesEqual(this.serverEpochValue, serverEpoch)) return;

    const wasEstablished = this.established;
    this.patchBuffer.clearPending();
    this.records.clear();
    this.removedAt.clear();
    this.paneEpochs.clear();
    this.unknownPaneHints.clear();
    this.unknownPaneBytes = 0;
    this.serverEpochValue = copyBytes(serverEpoch);
    this.metadataEpochValue = copyBytes(this.createEpoch());
    this.revisionValue = 0n;
    this.established = false;
    if (wasEstablished) this.onRebaseRequired?.(this.currentSnapshot());
  }

  currentSnapshot(): MetadataProjectionSnapshot {
    return {
      metadataEpoch: this.metadataEpoch,
      revision: this.revisionValue,
      records: Array.from(this.records.values(), (record) => toWireRecord(record)),
    };
  }

  reconcile(snapshot: StateSnapshotPayload, baseRevision = this.revisionValue): void {
    if (this.disposed || !this.serverEpochValue) return;
    const desired = this.hierarchy.buildDesired(snapshot);

    if (!this.established) {
      const revision = 1n;
      this.records.clear();
      for (const [id, record] of desired) {
        this.records.set(id, createRecord(record, revision));
      }
      this.revisionValue = revision;
      this.established = true;
      return;
    }

    const nextRevision = this.revisionValue + 1n;
    const plan = buildMetadataReconcilePlan(
      this.records,
      this.removedAt,
      desired,
      baseRevision,
      nextRevision
    );
    if (plan.actions.length === 0) return;
    this.patchBuffer.beginDirtyRevision(this.revisionValue);
    this.revisionValue = nextRevision;
    for (const action of plan.actions) this.applyReconcileAction(action, nextRevision);
    this.patchBuffer.finishMutation();
  }

  private applyReconcileAction(action: MetadataReconcileAction, nextRevision: bigint): void {
    if (action.kind === 'create') {
      const created = createRecord(action.wanted, nextRevision);
      this.records.set(action.id, created);
      this.removedAt.delete(action.id);
      this.patchBuffer.markFullUpsert(created);
      return;
    }
    if (action.kind === 'remove') {
      this.removeRecord(action.record, nextRevision);
      return;
    }
    const current = action.record;
    current.entityRevision = nextRevision;
    if (action.parentChanged) {
      current.parent = action.wanted.parent ? cloneKey(action.wanted.parent) : null;
      current.parentRevision = nextRevision;
      this.patchBuffer.markUpsert(current);
    }
    for (const [fieldId, value] of action.fieldChanges) {
      this.setRecordField(current, fieldId, value, nextRevision);
    }
  }

  applySourceEvent(event: TmuxSourceMetadataEvent): void {
    if (this.disposed) return;
    if (!this.established) {
      this.eventApplier.cacheUnknown(event);
      return;
    }

    const nextRevision = this.revisionValue + 1n;
    const actions = this.eventApplier.collect(event, nextRevision);
    if (actions.length === 0) return;
    this.patchBuffer.beginDirtyRevision(this.revisionValue);
    this.revisionValue = nextRevision;
    for (const action of actions) action();
    this.patchBuffer.finishMutation();
  }

  setCustomName(kind: 'window' | 'pane', nativeId: string, name: string | null): void {
    if (this.disposed) return;
    const names = kind === 'window' ? this.windowCustomNames : this.paneCustomNames;
    if (name) names.set(nativeId, name);
    else names.delete(nativeId);

    const entityKind =
      kind === 'window' ? wsBorsh.SOURCE_ENTITY_WINDOW : wsBorsh.SOURCE_ENTITY_PANE;
    const record = this.records.get(keyId({ entityKind, nativeId }));
    if (!record) return;
    const previous = record.fields.get(wsBorsh.SOURCE_FIELD_CUSTOM_NAME)?.value;
    const value = name ? stringValue(name) : null;
    if (valueEqual(previous, value ?? undefined)) return;

    const nextRevision = this.revisionValue + 1n;
    this.patchBuffer.beginDirtyRevision(this.revisionValue);
    this.revisionValue = nextRevision;
    this.setRecordField(record, wsBorsh.SOURCE_FIELD_CUSTOM_NAME, value, nextRevision);
    this.patchBuffer.finishMutation();
  }

  flushPending(): void {
    this.patchBuffer.flushPending();
  }

  dispose(): void {
    this.disposed = true;
    this.patchBuffer.dispose();
    this.records.clear();
    this.unknownPaneHints.clear();
    this.unknownPaneBytes = 0;
  }

  private setRecordField(
    record: ProjectedRecord,
    field: number,
    value: MetadataValue | null,
    revision: bigint
  ): void {
    record.entityRevision = revision;
    if (value) record.fields.set(field, { value: cloneValue(value), revision });
    else record.fields.delete(field);
    this.patchBuffer.markUpsert(record, field, value ?? { Unset: {} });
  }

  private removeRecord(record: ProjectedRecord, revision: bigint): void {
    const descendants = Array.from(this.records.values()).filter(
      (candidate) => candidate.parent && keyEqual(candidate.parent, record.key)
    );
    for (const descendant of descendants) this.removeRecord(descendant, revision);

    const id = keyId(record.key);
    this.records.delete(id);
    this.removedAt.set(id, revision);
    this.paneEpochs.delete(record.key.nativeId);
    this.patchBuffer.markRemoval(record.key);
  }

  private rememberUnknownPane(paneId: string, fields: PaneFieldHints): void {
    const previous = this.unknownPaneHints.get(paneId) ?? {};
    const merged = { ...previous, ...fields };
    if (!this.unknownPaneHints.has(paneId) && this.unknownPaneHints.size >= MAX_UNKNOWN_PANES) {
      const oldest = this.unknownPaneHints.keys().next().value;
      if (oldest) this.deleteUnknownPane(oldest);
    }
    this.unknownPaneHints.set(paneId, merged);
    this.recalculateUnknownPaneBytes();
    while (this.unknownPaneBytes > MAX_UNKNOWN_PANE_BYTES) {
      const oldest = this.unknownPaneHints.keys().next().value;
      if (!oldest) break;
      this.deleteUnknownPane(oldest);
    }
  }

  private deleteUnknownPane(paneId: string): void {
    this.unknownPaneHints.delete(paneId);
    this.recalculateUnknownPaneBytes();
  }

  private recalculateUnknownPaneBytes(): void {
    this.unknownPaneBytes = 0;
    for (const [paneId, fields] of this.unknownPaneHints) {
      this.unknownPaneBytes += paneId.length * 3;
      this.unknownPaneBytes += (fields.title?.length ?? 0) * 3;
      this.unknownPaneBytes += (fields.currentPath?.length ?? 0) * 3;
      this.unknownPaneBytes += (fields.currentCommand?.length ?? 0) * 3;
    }
  }
}
