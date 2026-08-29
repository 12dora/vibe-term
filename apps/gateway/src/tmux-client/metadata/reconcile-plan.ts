import { wsBorsh } from '@tmex/shared';

import {
  type MetadataValue,
  type PendingUpsert,
  type ProjectedRecord,
  keyEqual,
  valueEqual,
} from './types';

export interface MetadataReconcileCreate {
  kind: 'create';
  id: string;
  wanted: PendingUpsert;
}

export interface MetadataReconcileUpdate {
  kind: 'update';
  id: string;
  wanted: PendingUpsert;
  record: ProjectedRecord;
  parentChanged: boolean;
  fieldChanges: Array<[number, MetadataValue | null]>;
}

export interface MetadataReconcileRemoval {
  kind: 'remove';
  id: string;
  record: ProjectedRecord;
}

export type MetadataReconcileAction =
  | MetadataReconcileCreate
  | MetadataReconcileUpdate
  | MetadataReconcileRemoval;

export interface MetadataReconcilePlan {
  nextRevision: bigint;
  creates: MetadataReconcileCreate[];
  updates: MetadataReconcileUpdate[];
  removals: string[];
  actions: MetadataReconcileAction[];
}

function collectFieldChanges(
  current: ProjectedRecord,
  wanted: PendingUpsert,
  baseRevision: bigint
): Array<[number, MetadataValue | null]> {
  const fieldChanges: Array<[number, MetadataValue | null]> = [];
  const wantedFields = wanted.fields;
  const allFieldIds = new Set([...current.fields.keys(), ...wantedFields.keys()]);
  for (const fieldId of allFieldIds) {
    if (fieldId === wsBorsh.SOURCE_FIELD_CUSTOM_NAME && !wantedFields.has(fieldId)) continue;
    const previous = current.fields.get(fieldId);
    if (previous && previous.revision > baseRevision) continue;
    const wantedValue = wantedFields.get(fieldId);
    if (!valueEqual(previous?.value, wantedValue)) {
      fieldChanges.push([fieldId, wantedValue ?? null]);
    }
  }
  return fieldChanges;
}

export function buildMetadataReconcilePlan(
  records: ReadonlyMap<string, ProjectedRecord>,
  removedAt: ReadonlyMap<string, bigint>,
  desired: ReadonlyMap<string, PendingUpsert>,
  baseRevision: bigint,
  nextRevision: bigint
): MetadataReconcilePlan {
  const creates: MetadataReconcileCreate[] = [];
  const updates: MetadataReconcileUpdate[] = [];
  const removals: string[] = [];
  const actions: MetadataReconcileAction[] = [];

  for (const [id, wanted] of desired) {
    const current = records.get(id);
    if (!current) {
      if ((removedAt.get(id) ?? -1n) > baseRevision) continue;
      const create: MetadataReconcileCreate = { kind: 'create', id, wanted };
      creates.push(create);
      actions.push(create);
      continue;
    }

    const parentChanged =
      current.parentRevision <= baseRevision && !keyEqual(current.parent, wanted.parent);
    const fieldChanges = collectFieldChanges(current, wanted, baseRevision);
    if (!parentChanged && fieldChanges.length === 0) continue;
    const update: MetadataReconcileUpdate = {
      kind: 'update',
      id,
      wanted,
      record: current,
      parentChanged,
      fieldChanges,
    };
    updates.push(update);
    actions.push(update);
  }

  for (const [id, current] of records) {
    if (desired.has(id) || current.entityRevision > baseRevision) continue;
    removals.push(id);
    actions.push({ kind: 'remove', id, record: current });
  }

  return { nextRevision, creates, updates, removals, actions };
}
