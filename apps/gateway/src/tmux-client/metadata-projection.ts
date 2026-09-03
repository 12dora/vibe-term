import { type StateSnapshotPayload, wsBorsh } from '@tmex/shared';

import type { TmuxSourceMetadataEvent } from './events';
import { MetadataEventApplier } from './metadata/event-applier';
import { MetadataHierarchyBuilder } from './metadata/hierarchy-builder';
import { MetadataPatchBuffer } from './metadata/patch-buffer';
import {
  type PlannedFieldChange,
  type PlannedParentChange,
  type ReconcilePlan,
  planReconcile,
  reconcilePlanHasWork,
} from './metadata/reconcile-plan';
import {
  MAX_UNKNOWN_PANES,
  MAX_UNKNOWN_PANE_BYTES,
  type MetadataProjectionOptions,
  type MetadataProjectionPatch,
  type MetadataProjectionSnapshot,
  type MetadataValue,
  type PaneFieldHints,
  type PendingUpsert,
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
  u32Value,
  valueEqual,
} from './metadata/types';

export type { MetadataProjectionOptions, MetadataProjectionPatch, MetadataProjectionSnapshot };

export interface DeviceTreeOrderInput {
  windows: readonly string[];
  panes: Readonly<Record<string, readonly string[]>>;
}

function treeOrderPaneKey(windowId: string, paneId: string): string {
  return `${windowId}\0${paneId}`;
}

function indexById(ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  ids.forEach((id, index) => {
    if (!out.has(id)) out.set(id, index);
  });
  return out;
}

function indexPanesById(panes: Readonly<Record<string, readonly string[]>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [windowId, paneIds] of Object.entries(panes)) {
    paneIds.forEach((paneId, index) => {
      const key = treeOrderPaneKey(windowId, paneId);
      if (!out.has(key)) out.set(key, index);
    });
  }
  return out;
}

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
  private treeOrderWindows = new Map<string, number>();
  private treeOrderPanes = new Map<string, number>();
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
      getWindowTreeOrder: (windowId) => this.treeOrderWindows.get(windowId),
      getPaneTreeOrder: (windowId, paneId) =>
        this.treeOrderPanes.get(treeOrderPaneKey(windowId, paneId)),
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
      this.establish(desired);
      return;
    }
    this.commitReconcilePlan(
      planReconcile({
        current: this.records,
        desired,
        removedAt: this.removedAt,
        baseRevision,
      })
    );
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

  /**
   * 设备树自定义显示顺序：以 SOURCE_FIELD_TREE_ORDER 字段随 canonical metadata 下发。
   * 退出自定义顺序的实体写 Unset，消费方据此回落到 tmux index 顺序。
   */
  setTreeOrder(order: DeviceTreeOrderInput): void {
    if (this.disposed) return;
    this.treeOrderWindows = indexById(order.windows);
    this.treeOrderPanes = indexPanesById(order.panes);
    if (!this.established) return;

    const changes: Array<[ProjectedRecord, MetadataValue | null]> = [];
    for (const record of this.records.values()) {
      const next = this.treeOrderValueOf(record);
      if (
        valueEqual(record.fields.get(wsBorsh.SOURCE_FIELD_TREE_ORDER)?.value, next ?? undefined)
      ) {
        continue;
      }
      changes.push([record, next]);
    }
    if (changes.length === 0) return;

    const nextRevision = this.revisionValue + 1n;
    this.patchBuffer.beginDirtyRevision(this.revisionValue);
    this.revisionValue = nextRevision;
    for (const [record, value] of changes) {
      this.setRecordField(record, wsBorsh.SOURCE_FIELD_TREE_ORDER, value, nextRevision);
    }
    this.patchBuffer.finishMutation();
  }

  private treeOrderValueOf(record: ProjectedRecord): MetadataValue | null {
    if (record.key.entityKind === wsBorsh.SOURCE_ENTITY_WINDOW) {
      const index = this.treeOrderWindows.get(record.key.nativeId);
      return index === undefined ? null : u32Value(index);
    }
    if (record.key.entityKind !== wsBorsh.SOURCE_ENTITY_PANE || !record.parent) return null;
    const index = this.treeOrderPanes.get(
      treeOrderPaneKey(record.parent.nativeId, record.key.nativeId)
    );
    return index === undefined ? null : u32Value(index);
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

  private establish(desired: Map<string, PendingUpsert>): void {
    const revision = 1n;
    this.records.clear();
    for (const [id, record] of desired) {
      this.records.set(id, createRecord(record, revision));
    }
    this.revisionValue = revision;
    this.established = true;
  }

  private commitReconcilePlan(plan: ReconcilePlan): void {
    if (!reconcilePlanHasWork(plan)) return;
    const nextRevision = this.revisionValue + 1n;
    this.patchBuffer.beginDirtyRevision(this.revisionValue);
    this.revisionValue = nextRevision;
    this.applyReconcilePlan(plan, nextRevision);
    this.patchBuffer.finishMutation();
  }

  private applyReconcilePlan(plan: ReconcilePlan, revision: bigint): void {
    for (const addition of plan.additions) {
      const created = createRecord(addition.wanted, revision);
      this.records.set(addition.id, created);
      this.removedAt.delete(addition.id);
      this.patchBuffer.markFullUpsert(created);
    }
    for (const change of plan.parentChanges) this.applyParentChange(change, revision);
    for (const change of plan.fieldChanges) this.applyFieldChanges(change, revision);
    for (const removal of plan.removals) this.removeRecord(removal.record, revision);
  }

  private applyParentChange(change: PlannedParentChange, revision: bigint): void {
    const current = change.record;
    current.entityRevision = revision;
    current.parent = change.parent ? cloneKey(change.parent) : null;
    current.parentRevision = revision;
    this.patchBuffer.markUpsert(current);
  }

  private applyFieldChanges(change: PlannedFieldChange, revision: bigint): void {
    change.record.entityRevision = revision;
    for (const [fieldId, value] of change.fields) {
      this.setRecordField(change.record, fieldId, value, revision);
    }
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
