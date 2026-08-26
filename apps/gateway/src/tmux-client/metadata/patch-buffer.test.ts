import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';

import { MetadataPatchBuffer } from './patch-buffer';
import {
  type MetadataProjectionPatch,
  type MetadataProjectionSnapshot,
  type ProjectedRecord,
  createRecord,
  stringValue,
} from './types';

const EPOCH = new Uint8Array(16).fill(3);

function record(nativeId = '@1'): ProjectedRecord {
  return createRecord(
    {
      key: {
        deviceId: 'device-a',
        serverEpoch: EPOCH,
        entityKind: wsBorsh.SOURCE_ENTITY_WINDOW,
        nativeId,
      },
      parent: null,
      fields: new Map([[wsBorsh.SOURCE_FIELD_NAME, stringValue(nativeId)]]),
    },
    1n
  );
}

function createBuffer(
  overrides: {
    revision?: bigint;
    maxPendingBytes?: number;
    onPatch?: (patch: MetadataProjectionPatch) => void;
    onRebaseRequired?: (snapshot: MetadataProjectionSnapshot) => void;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
  } = {}
) {
  let revision = overrides.revision ?? 1n;
  const patches: MetadataProjectionPatch[] = [];
  const rebases: MetadataProjectionSnapshot[] = [];
  const buffer = new MetadataPatchBuffer({
    flushIntervalMs: 25,
    maxPendingBytes: overrides.maxPendingBytes,
    getMetadataEpoch: () => EPOCH,
    getRevision: () => revision,
    currentSnapshot: () => ({ metadataEpoch: EPOCH, revision, records: [] }),
    onPatch: (patch) => {
      patches.push(patch);
      overrides.onPatch?.(patch);
    },
    onRebaseRequired: (snapshot) => {
      rebases.push(snapshot);
      overrides.onRebaseRequired?.(snapshot);
    },
    setTimeout: overrides.setTimeout,
    clearTimeout: overrides.clearTimeout,
  });
  return {
    buffer,
    patches,
    rebases,
    setRevision: (value: bigint) => {
      revision = value;
    },
  };
}

describe('MetadataPatchBuffer', () => {
  test('beginDirtyRevision keeps the first fromRevision and flush encodes a patch', () => {
    const { buffer, patches, setRevision } = createBuffer();
    buffer.beginDirtyRevision(1n);
    buffer.beginDirtyRevision(2n);
    buffer.markFullUpsert(record());
    setRevision(2n);
    buffer.flushPending();
    expect(patches).toHaveLength(1);
    expect(patches[0]?.fromRevision).toBe(1n);
    expect(patches[0]?.throughRevision).toBe(2n);
    expect(patches[0]?.upserts).toHaveLength(1);
  });

  test('coalesces upserts onto one entity and cancel on removal', () => {
    const { buffer, patches, setRevision } = createBuffer();
    const entity = record('%1');
    buffer.beginDirtyRevision(1n);
    buffer.markUpsert(entity, wsBorsh.SOURCE_FIELD_NAME, stringValue('one'));
    buffer.markUpsert(entity, wsBorsh.SOURCE_FIELD_NAME, stringValue('two'));
    setRevision(2n);
    buffer.flushPending();
    expect(patches).toHaveLength(1);
    expect(patches[0]?.upserts[0]?.fields).toEqual([
      { field: wsBorsh.SOURCE_FIELD_NAME, value: { String: 'two' } },
    ]);

    buffer.beginDirtyRevision(2n);
    buffer.markUpsert(entity, wsBorsh.SOURCE_FIELD_NAME, stringValue('gone'));
    buffer.markRemoval(entity.key);
    setRevision(3n);
    buffer.flushPending();
    expect(patches[1]?.upserts).toEqual([]);
    expect(patches[1]?.removals.map((key) => key.nativeId)).toEqual(['%1']);
  });

  test('oversized pending buffer requests a rebase instead of flushing', () => {
    const { buffer, patches, rebases } = createBuffer({ maxPendingBytes: 8 });
    buffer.beginDirtyRevision(1n);
    buffer.markFullUpsert(record('a-very-long-native-id-to-blow-the-budget'));
    buffer.finishMutation();
    expect(patches).toEqual([]);
    expect(rebases).toHaveLength(1);
    buffer.flushPending();
    expect(patches).toEqual([]);
  });

  test('finishMutation does not reset an already scheduled flush timer', () => {
    const scheduled: Array<() => void> = [];
    let cleared = 0;
    const { buffer, patches } = createBuffer({
      setTimeout: ((fn: () => void) => {
        scheduled.push(fn);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeout: (() => {
        cleared += 1;
      }) as typeof clearTimeout,
    });
    buffer.beginDirtyRevision(1n);
    buffer.markFullUpsert(record());
    buffer.finishMutation();
    buffer.markUpsert(record(), wsBorsh.SOURCE_FIELD_NAME, stringValue('later'));
    buffer.finishMutation();
    expect(scheduled).toHaveLength(1);
    buffer.dispose();
    expect(cleared).toBe(1);
    expect(patches).toEqual([]);
  });
});
