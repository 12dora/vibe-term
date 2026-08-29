import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';

import { buildMetadataReconcilePlan } from './reconcile-plan';
import {
  type PendingUpsert,
  type ProjectedRecord,
  createRecord,
  keyId,
  stringValue,
} from './types';

const SERVER_EPOCH = new Uint8Array(16);

function entityKey(kind: number, nativeId: string): wsBorsh.SourceEntityKey {
  return {
    deviceId: 'device-a',
    serverEpoch: SERVER_EPOCH,
    entityKind: kind,
    nativeId,
  };
}

function paneUpsert(
  nativeId: string,
  fields: Array<[number, wsBorsh.SourceMetadataValue]>,
  parentNativeId = '@1'
): PendingUpsert {
  return {
    key: entityKey(wsBorsh.SOURCE_ENTITY_PANE, nativeId),
    parent: entityKey(wsBorsh.SOURCE_ENTITY_WINDOW, parentNativeId),
    fields: new Map(fields),
  };
}

function recordOf(wanted: PendingUpsert, revision: bigint): ProjectedRecord {
  return createRecord(wanted, revision);
}

function idOf(wanted: PendingUpsert): string {
  return keyId(wanted.key);
}

describe('buildMetadataReconcilePlan', () => {
  test('creates a missing record unless a newer tombstone exists', () => {
    const wanted = paneUpsert('%1', [[wsBorsh.SOURCE_FIELD_TITLE, stringValue('shell')]]);
    const id = idOf(wanted);
    const desired = new Map([[id, wanted]]);

    const created = buildMetadataReconcilePlan(new Map(), new Map(), desired, 1n, 2n);
    expect(created.creates).toEqual([{ kind: 'create', id, wanted }]);
    expect(created.updates).toEqual([]);
    expect(created.removals).toEqual([]);
    expect(created.nextRevision).toBe(2n);

    const tombstoned = buildMetadataReconcilePlan(new Map(), new Map([[id, 5n]]), desired, 1n, 2n);
    expect(tombstoned.creates).toEqual([]);

    const expiredTombstone = buildMetadataReconcilePlan(
      new Map(),
      new Map([[id, 1n]]),
      desired,
      1n,
      2n
    );
    expect(expiredTombstone.creates).toEqual([{ kind: 'create', id, wanted }]);
  });

  test('skips stale field patches and preserves projection-owned custom names', () => {
    const wanted = paneUpsert('%1', [[wsBorsh.SOURCE_FIELD_TITLE, stringValue('old')]]);
    const current = recordOf(
      paneUpsert('%1', [
        [wsBorsh.SOURCE_FIELD_TITLE, stringValue('new')],
        [wsBorsh.SOURCE_FIELD_CUSTOM_NAME, stringValue('mine')],
      ]),
      1n
    );
    const title = current.fields.get(wsBorsh.SOURCE_FIELD_TITLE);
    if (!title) throw new Error('expected title field');
    title.revision = 5n;

    const plan = buildMetadataReconcilePlan(
      new Map([[idOf(wanted), current]]),
      new Map(),
      new Map([[idOf(wanted), wanted]]),
      1n,
      2n
    );
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([]);
    expect(plan.removals).toEqual([]);
  });

  test('queues field unsets and parent moves that are not newer than the base revision', () => {
    const current = recordOf(
      paneUpsert('%1', [
        [wsBorsh.SOURCE_FIELD_TITLE, stringValue('shell')],
        [wsBorsh.SOURCE_FIELD_CURRENT_PATH, stringValue('/work')],
      ]),
      1n
    );
    const wanted = paneUpsert('%1', [[wsBorsh.SOURCE_FIELD_TITLE, stringValue('shell')]], '@2');

    const plan = buildMetadataReconcilePlan(
      new Map([[idOf(wanted), current]]),
      new Map(),
      new Map([[idOf(wanted), wanted]]),
      1n,
      2n
    );
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]?.parentChanged).toBe(true);
    expect(plan.updates[0]?.fieldChanges).toEqual([[wsBorsh.SOURCE_FIELD_CURRENT_PATH, null]]);

    current.parentRevision = 5n;
    const staleParent = buildMetadataReconcilePlan(
      new Map([[idOf(wanted), current]]),
      new Map(),
      new Map([[idOf(wanted), wanted]]),
      1n,
      2n
    );
    expect(staleParent.updates[0]?.parentChanged).toBe(false);
    expect(staleParent.updates[0]?.fieldChanges).toEqual([
      [wsBorsh.SOURCE_FIELD_CURRENT_PATH, null],
    ]);
  });

  test('removes records absent from desired unless the entity is newer than base', () => {
    const staleWanted = paneUpsert('%1', [[wsBorsh.SOURCE_FIELD_TITLE, stringValue('gone')]]);
    const freshWanted = paneUpsert('%2', [[wsBorsh.SOURCE_FIELD_TITLE, stringValue('kept-event')]]);
    const kept = paneUpsert('%3', [[wsBorsh.SOURCE_FIELD_TITLE, stringValue('kept')]]);
    const records = new Map<string, ProjectedRecord>([
      [idOf(staleWanted), recordOf(staleWanted, 1n)],
      [idOf(freshWanted), recordOf(freshWanted, 5n)],
      [idOf(kept), recordOf(kept, 1n)],
    ]);

    const plan = buildMetadataReconcilePlan(
      records,
      new Map(),
      new Map([[idOf(kept), kept]]),
      1n,
      2n
    );
    expect(plan.removals).toEqual([idOf(staleWanted)]);
    expect(plan.creates).toEqual([]);
  });

  test('orders creates and updates in desired iteration order before removals', () => {
    const existing = paneUpsert('%1', [[wsBorsh.SOURCE_FIELD_TITLE, stringValue('old')]]);
    const created = paneUpsert('%2', [[wsBorsh.SOURCE_FIELD_TITLE, stringValue('new')]]);
    const gone = paneUpsert('%3', [[wsBorsh.SOURCE_FIELD_TITLE, stringValue('gone')]]);
    const desired = new Map([
      [idOf(existing), paneUpsert('%1', [[wsBorsh.SOURCE_FIELD_TITLE, stringValue('next')]])],
      [idOf(created), created],
    ]);
    const records = new Map([
      [idOf(existing), recordOf(existing, 1n)],
      [idOf(gone), recordOf(gone, 1n)],
    ]);

    const plan = buildMetadataReconcilePlan(records, new Map(), desired, 1n, 2n);
    expect(plan.creates.map((item) => item.id)).toEqual([idOf(created)]);
    expect(plan.updates.map((item) => item.id)).toEqual([idOf(existing)]);
    expect(plan.removals).toEqual([idOf(gone)]);
    expect(plan.updates[0]?.fieldChanges).toEqual([
      [wsBorsh.SOURCE_FIELD_TITLE, stringValue('next')],
    ]);
    expect(plan.actions.map((item) => `${item.kind}:${item.id}`)).toEqual([
      `update:${idOf(existing)}`,
      `create:${idOf(created)}`,
      `remove:${idOf(gone)}`,
    ]);
  });
});
