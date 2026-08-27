import { wsBorsh } from '@tmex/shared';

import {
  type MetadataValue,
  type PendingUpsert,
  type ProjectedRecord,
  keyEqual,
  valueEqual,
} from './types';

export type ReconcileConflictKind = 'addition' | 'field' | 'parent' | 'removal';

export interface ReconcileConflict {
  id: string;
  kind: ReconcileConflictKind;
}

export interface ReconcilePlanInput {
  current: ReadonlyMap<string, ProjectedRecord>;
  desired: ReadonlyMap<string, PendingUpsert>;
  removedAt: ReadonlyMap<string, bigint>;
  baseRevision: bigint;
}

export interface PlannedAddition {
  id: string;
  wanted: PendingUpsert;
}

export interface PlannedFieldChange {
  id: string;
  record: ProjectedRecord;
  fields: Array<[number, MetadataValue | null]>;
}

export interface PlannedParentChange {
  id: string;
  record: ProjectedRecord;
  parent: wsBorsh.SourceEntityKey | null;
}

export interface PlannedRemoval {
  id: string;
  record: ProjectedRecord;
}

export interface ReconcilePlan {
  additions: PlannedAddition[];
  fieldChanges: PlannedFieldChange[];
  parentChanges: PlannedParentChange[];
  removals: PlannedRemoval[];
  conflicts: ReconcileConflict[];
}

type FieldDecision =
  | { kind: 'skip' }
  | { kind: 'conflict' }
  | { kind: 'change'; value: MetadataValue | null };

export function planReconcile(input: ReconcilePlanInput): ReconcilePlan {
  const plan = emptyPlan();
  planDesiredRecords(input, plan);
  planRemovals(input, plan);
  return plan;
}

export function reconcilePlanHasWork(plan: ReconcilePlan): boolean {
  return (
    plan.additions.length > 0 ||
    plan.fieldChanges.length > 0 ||
    plan.parentChanges.length > 0 ||
    plan.removals.length > 0
  );
}

function emptyPlan(): ReconcilePlan {
  return {
    additions: [],
    fieldChanges: [],
    parentChanges: [],
    removals: [],
    conflicts: [],
  };
}

function planDesiredRecords(input: ReconcilePlanInput, plan: ReconcilePlan): void {
  for (const [id, wanted] of input.desired) {
    const current = input.current.get(id);
    if (!current) {
      planMissingRecord(id, wanted, input, plan);
      continue;
    }
    planParentChange(id, current, wanted, input.baseRevision, plan);
    planFieldChanges(id, current, wanted, input.baseRevision, plan);
  }
}

function planMissingRecord(
  id: string,
  wanted: PendingUpsert,
  input: ReconcilePlanInput,
  plan: ReconcilePlan
): void {
  if ((input.removedAt.get(id) ?? -1n) > input.baseRevision) {
    plan.conflicts.push({ id, kind: 'addition' });
    return;
  }
  plan.additions.push({ id, wanted });
}

function planParentChange(
  id: string,
  current: ProjectedRecord,
  wanted: PendingUpsert,
  baseRevision: bigint,
  plan: ReconcilePlan
): void {
  if (keyEqual(current.parent, wanted.parent)) return;
  if (current.parentRevision > baseRevision) {
    plan.conflicts.push({ id, kind: 'parent' });
    return;
  }
  plan.parentChanges.push({ id, record: current, parent: wanted.parent });
}

function planFieldChanges(
  id: string,
  current: ProjectedRecord,
  wanted: PendingUpsert,
  baseRevision: bigint,
  plan: ReconcilePlan
): void {
  const fields: Array<[number, MetadataValue | null]> = [];
  const allFieldIds = new Set([...current.fields.keys(), ...wanted.fields.keys()]);
  for (const fieldId of allFieldIds) {
    const decision = classifyFieldChange(fieldId, current, wanted, baseRevision);
    if (decision.kind === 'skip') continue;
    if (decision.kind === 'conflict') {
      plan.conflicts.push({ id, kind: 'field' });
      continue;
    }
    fields.push([fieldId, decision.value]);
  }
  if (fields.length > 0) plan.fieldChanges.push({ id, record: current, fields });
}

function classifyFieldChange(
  fieldId: number,
  current: ProjectedRecord,
  wanted: PendingUpsert,
  baseRevision: bigint
): FieldDecision {
  if (fieldId === wsBorsh.SOURCE_FIELD_CUSTOM_NAME && !wanted.fields.has(fieldId)) {
    return { kind: 'skip' };
  }
  const previous = current.fields.get(fieldId);
  const wantedValue = wanted.fields.get(fieldId);
  if (valueEqual(previous?.value, wantedValue)) return { kind: 'skip' };
  if (previous && previous.revision > baseRevision) return { kind: 'conflict' };
  return { kind: 'change', value: wantedValue ?? null };
}

function planRemovals(input: ReconcilePlanInput, plan: ReconcilePlan): void {
  for (const [id, current] of input.current) {
    if (input.desired.has(id)) continue;
    if (current.entityRevision > input.baseRevision) {
      plan.conflicts.push({ id, kind: 'removal' });
      continue;
    }
    plan.removals.push({ id, record: current });
  }
}
