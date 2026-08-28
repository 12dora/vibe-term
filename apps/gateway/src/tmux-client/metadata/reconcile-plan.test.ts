import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';

import {
  type ReconcileConflict,
  type ReconcilePlanInput,
  planReconcile,
  reconcilePlanHasWork,
} from './reconcile-plan';
import {
  type MetadataValue,
  type PendingUpsert,
  type ProjectedRecord,
  createRecord,
  keyId,
  stringValue,
} from './types';

const SERVER_EPOCH = new Uint8Array(16).fill(1);

function entityKey(kind: number, nativeId: string): wsBorsh.SourceEntityKey {
  return {
    deviceId: 'device-a',
    serverEpoch: SERVER_EPOCH,
    entityKind: kind,
    nativeId,
  };
}

function paneId(nativeId = '%1'): string {
  return keyId({ entityKind: wsBorsh.SOURCE_ENTITY_PANE, nativeId });
}

function paneUpsert(
  nativeId: string,
  parentNativeId: string,
  title: string,
  extraFields?: Iterable<[number, MetadataValue]>
): PendingUpsert {
  return {
    key: entityKey(wsBorsh.SOURCE_ENTITY_PANE, nativeId),
    parent: entityKey(wsBorsh.SOURCE_ENTITY_WINDOW, parentNativeId),
    fields: new Map([[wsBorsh.SOURCE_FIELD_TITLE, stringValue(title)], ...(extraFields ?? [])]),
  };
}

function paneRecord(
  nativeId: string,
  parentNativeId: string,
  title: string,
  revision: bigint,
  options: {
    extraFields?: Iterable<[number, MetadataValue]>;
    fieldRevision?: bigint;
    parentRevision?: bigint;
    entityRevision?: bigint;
  } = {}
): ProjectedRecord {
  const record = createRecord(
    paneUpsert(nativeId, parentNativeId, title, options.extraFields),
    revision
  );
  if (options.fieldRevision !== undefined) {
    for (const state of record.fields.values()) state.revision = options.fieldRevision;
  }
  if (options.parentRevision !== undefined) record.parentRevision = options.parentRevision;
  if (options.entityRevision !== undefined) record.entityRevision = options.entityRevision;
  return record;
}

function asRecords(...items: ProjectedRecord[]): Map<string, ProjectedRecord> {
  return new Map(items.map((item) => [keyId(item.key), item]));
}

function asDesired(...items: PendingUpsert[]): Map<string, PendingUpsert> {
  return new Map(items.map((item) => [keyId(item.key), item]));
}

interface PlanCase {
  name: string;
  input: ReconcilePlanInput;
  additionIds: string[];
  fieldChanges: Array<{ id: string; fields: Array<[number, MetadataValue | null]> }>;
  parentNativeIds: Array<{ id: string; parentNativeId: string | null }>;
  removalIds: string[];
  conflicts: ReconcileConflict[];
  hasWork: boolean;
}

const CASES: PlanCase[] = [
  {
    name: 'add-only',
    input: {
      current: asRecords(),
      desired: asDesired(paneUpsert('%1', '@1', 'shell')),
      removedAt: new Map(),
      baseRevision: 1n,
    },
    additionIds: [paneId()],
    fieldChanges: [],
    parentNativeIds: [],
    removalIds: [],
    conflicts: [],
    hasWork: true,
  },
  {
    name: 'change-only',
    input: {
      current: asRecords(paneRecord('%1', '@1', 'shell', 1n)),
      desired: asDesired(paneUpsert('%1', '@1', 'zsh')),
      removedAt: new Map(),
      baseRevision: 1n,
    },
    additionIds: [],
    fieldChanges: [{ id: paneId(), fields: [[wsBorsh.SOURCE_FIELD_TITLE, stringValue('zsh')]] }],
    parentNativeIds: [],
    removalIds: [],
    conflicts: [],
    hasWork: true,
  },
  {
    name: 'reparent',
    input: {
      current: asRecords(paneRecord('%1', '@1', 'shell', 1n)),
      desired: asDesired(paneUpsert('%1', '@2', 'shell')),
      removedAt: new Map(),
      baseRevision: 1n,
    },
    additionIds: [],
    fieldChanges: [],
    parentNativeIds: [{ id: paneId(), parentNativeId: '@2' }],
    removalIds: [],
    conflicts: [],
    hasWork: true,
  },
  {
    name: 'remove',
    input: {
      current: asRecords(paneRecord('%1', '@1', 'shell', 1n)),
      desired: asDesired(),
      removedAt: new Map(),
      baseRevision: 1n,
    },
    additionIds: [],
    fieldChanges: [],
    parentNativeIds: [],
    removalIds: [paneId()],
    conflicts: [],
    hasWork: true,
  },
  {
    name: 'conflict on stale field baseRevision',
    input: {
      current: asRecords(paneRecord('%1', '@1', 'new', 2n, { fieldRevision: 2n })),
      desired: asDesired(paneUpsert('%1', '@1', 'old')),
      removedAt: new Map(),
      baseRevision: 1n,
    },
    additionIds: [],
    fieldChanges: [],
    parentNativeIds: [],
    removalIds: [],
    conflicts: [{ id: paneId(), kind: 'field' }],
    hasWork: false,
  },
  {
    name: 'conflict on stale tombstone addition',
    input: {
      current: asRecords(),
      desired: asDesired(paneUpsert('%1', '@1', 'shell')),
      removedAt: new Map([[paneId(), 2n]]),
      baseRevision: 1n,
    },
    additionIds: [],
    fieldChanges: [],
    parentNativeIds: [],
    removalIds: [],
    conflicts: [{ id: paneId(), kind: 'addition' }],
    hasWork: false,
  },
  {
    name: 'conflict on stale parent baseRevision',
    input: {
      current: asRecords(paneRecord('%1', '@1', 'shell', 1n, { parentRevision: 2n })),
      desired: asDesired(paneUpsert('%1', '@2', 'shell')),
      removedAt: new Map(),
      baseRevision: 1n,
    },
    additionIds: [],
    fieldChanges: [],
    parentNativeIds: [],
    removalIds: [],
    conflicts: [{ id: paneId(), kind: 'parent' }],
    hasWork: false,
  },
  {
    name: 'conflict on stale removal baseRevision',
    input: {
      current: asRecords(paneRecord('%1', '@1', 'shell', 1n, { entityRevision: 2n })),
      desired: asDesired(),
      removedAt: new Map(),
      baseRevision: 1n,
    },
    additionIds: [],
    fieldChanges: [],
    parentNativeIds: [],
    removalIds: [],
    conflicts: [{ id: paneId(), kind: 'removal' }],
    hasWork: false,
  },
  {
    name: 'preserves projection-owned custom name',
    input: {
      current: asRecords(
        paneRecord('%1', '@1', 'shell', 1n, {
          extraFields: [[wsBorsh.SOURCE_FIELD_CUSTOM_NAME, stringValue('mine')]],
        })
      ),
      desired: asDesired(paneUpsert('%1', '@1', 'shell')),
      removedAt: new Map(),
      baseRevision: 1n,
    },
    additionIds: [],
    fieldChanges: [],
    parentNativeIds: [],
    removalIds: [],
    conflicts: [],
    hasWork: false,
  },
];

describe('planReconcile', () => {
  test.each(CASES)('$name', (row) => {
    const plan = planReconcile(row.input);
    expect(plan.additions.map((item) => item.id)).toEqual(row.additionIds);
    expect(plan.fieldChanges.map((item) => ({ id: item.id, fields: item.fields }))).toEqual(
      row.fieldChanges
    );
    expect(
      plan.parentChanges.map((item) => ({
        id: item.id,
        parentNativeId: item.parent?.nativeId ?? null,
      }))
    ).toEqual(row.parentNativeIds);
    expect(plan.removals.map((item) => item.id)).toEqual(row.removalIds);
    expect(plan.conflicts).toEqual(row.conflicts);
    expect(reconcilePlanHasWork(plan)).toBe(row.hasWork);
  });
});
