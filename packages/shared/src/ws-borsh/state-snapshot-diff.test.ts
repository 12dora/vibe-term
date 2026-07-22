import { describe, expect, test } from 'bun:test';

import type { StateSnapshotPayload } from '../index';
import {
  SOURCE_ENTITY_PANE,
  SOURCE_FIELD_CURRENT_PATH,
  SOURCE_FIELD_TITLE,
} from './canonical-state';
import {
  applyLegacyStateSnapshotDiff,
  decodeLegacyStateSnapshotDiff,
  encodeLegacyStateSnapshotDiff,
  sourceMetadataPatchToLegacyDiff,
} from './state-snapshot-diff';

const SERVER_EPOCH = new Uint8Array(16).fill(1);
const METADATA_EPOCH = new Uint8Array(16).fill(2);

function snapshot(): StateSnapshotPayload {
  return {
    deviceId: 'device-a',
    session: {
      id: '$1',
      name: 'work',
      windows: [
        {
          id: '@1',
          name: 'main',
          index: 0,
          active: true,
          panes: [
            {
              id: '%1',
              windowId: '@1',
              index: 0,
              active: true,
              width: 80,
              height: 24,
              title: 'old',
            },
          ],
        },
      ],
    },
  };
}

describe('absolute legacy state snapshot diff', () => {
  test('maps canonical absolute fields without carrying epoch-only data', () => {
    const diff = sourceMetadataPatchToLegacyDiff({
      metadataEpoch: METADATA_EPOCH,
      fromRevision: 1n,
      throughRevision: 2n,
      upserts: [
        {
          key: {
            deviceId: 'device-a',
            serverEpoch: SERVER_EPOCH,
            entityKind: SOURCE_ENTITY_PANE,
            nativeId: '%1',
          },
          parent: {
            deviceId: 'device-a',
            serverEpoch: SERVER_EPOCH,
            entityKind: 3,
            nativeId: '@1',
          },
          fields: [
            { field: SOURCE_FIELD_TITLE, value: { String: 'new' } },
            { field: SOURCE_FIELD_CURRENT_PATH, value: { String: '/work' } },
          ],
        },
      ],
      removals: [],
    });
    const roundTrip = decodeLegacyStateSnapshotDiff(encodeLegacyStateSnapshotDiff(diff));
    const applied = applyLegacyStateSnapshotDiff(snapshot(), roundTrip);
    expect(applied.session?.windows[0]?.panes[0]?.title).toBe('new');
    expect(applied.session?.windows[0]?.panes[0]?.currentPath).toBe('/work');
  });

  test('moves and removes panes by stable native id', () => {
    const current = snapshot();
    current.session?.windows.push({
      id: '@2',
      name: 'other',
      index: 1,
      active: false,
      panes: [],
    });
    const moved = applyLegacyStateSnapshotDiff(current, {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_PANE,
          nativeId: '%1',
          parentKind: 3,
          parentId: '@2',
          fields: [],
        },
      ],
      removals: [],
    });
    expect(moved.session?.windows[0]?.panes).toEqual([]);
    expect(moved.session?.windows[1]?.panes[0]?.windowId).toBe('@2');
    const removed = applyLegacyStateSnapshotDiff(moved, {
      upserts: [],
      removals: [{ entityKind: SOURCE_ENTITY_PANE, nativeId: '%1' }],
    });
    expect(removed.session?.windows[1]?.panes).toEqual([]);
  });
});
