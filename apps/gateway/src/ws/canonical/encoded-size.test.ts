import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';

import { canonicalEventPayloadBytes, sourceMetadataRecordBytes } from './encoded-size';

const EPOCH = new Uint8Array(16).fill(0x11);
const SNAPSHOT_ID = new Uint8Array(16).fill(0x22);

function record(nativeId: string, title: string): wsBorsh.SourceMetadataRecord {
  return {
    key: {
      deviceId: 'device-a',
      serverEpoch: EPOCH,
      entityKind: wsBorsh.SOURCE_ENTITY_PANE,
      nativeId,
    },
    parent: null,
    fields: [{ field: wsBorsh.SOURCE_FIELD_TITLE, value: { String: title } }],
  };
}

describe('sourceMetadataRecordBytes', () => {
  test('matches the incremental size of a snapshot vector item', () => {
    const items = [record('%1', 'shell'), record('%2', 'title 窗 café')];
    const empty = canonicalEventPayloadBytes({
      SourceMetadataSnapshot: {
        metadataEpoch: EPOCH,
        revision: 1n,
        snapshotId: SNAPSHOT_ID,
        chunkIndex: 0xffff,
        totalChunks: 0xffff,
        records: [],
      },
    });
    const full = canonicalEventPayloadBytes({
      SourceMetadataSnapshot: {
        metadataEpoch: EPOCH,
        revision: 1n,
        snapshotId: SNAPSHOT_ID,
        chunkIndex: 0xffff,
        totalChunks: 0xffff,
        records: items,
      },
    });
    const summed = items.reduce((total, item) => total + (sourceMetadataRecordBytes(item) ?? 0), 0);
    expect(empty).not.toBeNull();
    expect(full).toBe((empty ?? 0) + summed);
  });
});
