import { describe, expect, test } from 'bun:test';

import type { StateSnapshotPayload, TmuxWindow } from '../index';
import {
  SOURCE_ENTITY_PANE,
  SOURCE_ENTITY_SESSION,
  SOURCE_ENTITY_WINDOW,
  SOURCE_FIELD_CURRENT_PATH,
  SOURCE_FIELD_NAME,
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

function wideSnapshot(windowCount: number, panesPerWindow: number): StateSnapshotPayload {
  const windows: TmuxWindow[] = Array.from({ length: windowCount }, (_unused, windowIndex) => ({
    id: `@${windowIndex}`,
    name: `w${windowIndex}`,
    index: windowIndex,
    active: windowIndex === 0,
    panes: Array.from({ length: panesPerWindow }, (_ignored, paneIndex) => ({
      id: `%${windowIndex}-${paneIndex}`,
      windowId: `@${windowIndex}`,
      index: paneIndex,
      active: paneIndex === 0,
      width: 80,
      height: 24,
    })),
  }));
  return { deviceId: 'device-a', session: { id: '$1', name: 'work', windows } };
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

  test('只克隆被触碰的 window / pane，其余保持原引用', () => {
    const current = wideSnapshot(4, 3);
    const windows = current.session?.windows ?? [];
    const applied = applyLegacyStateSnapshotDiff(current, {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_PANE,
          nativeId: '%0-0',
          parentKind: SOURCE_ENTITY_WINDOW,
          parentId: '@0',
          fields: [[SOURCE_FIELD_TITLE, 'touched']],
        },
      ],
      removals: [],
    });
    const next = applied.session?.windows ?? [];

    expect(next).toHaveLength(windows.length);
    expect(next[0]).not.toBe(windows[0]);
    expect(next[0]?.panes[0]).not.toBe(windows[0]?.panes[0]);
    expect(next[0]?.panes[0]?.title).toBe('touched');
    expect(next[0]?.panes[1]).toBe(windows[0]?.panes[1]);
    for (let index = 1; index < windows.length; index += 1) {
      expect(next[index]).toBe(windows[index]);
    }
    expect(windows[0]?.panes[0]?.title).toBeUndefined();
  });

  test('window 未触碰时其 panes 数组也不重建', () => {
    const current = wideSnapshot(2, 2);
    const applied = applyLegacyStateSnapshotDiff(current, { upserts: [], removals: [] });
    expect(applied.session).not.toBe(current.session);
    expect(applied.session?.windows[0]).toBe(current.session?.windows[0]);
    expect(applied.session?.windows[1]).toBe(current.session?.windows[1]);
  });

  test('只改 window 字段时 panes 数组与 pane 对象都不重建', () => {
    const current = wideSnapshot(2, 3);
    const source = current.session?.windows[0];
    const applied = applyLegacyStateSnapshotDiff(current, {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_WINDOW,
          nativeId: '@0',
          parentKind: SOURCE_ENTITY_SESSION,
          parentId: '$1',
          fields: [[SOURCE_FIELD_NAME, 'renamed']],
        },
      ],
      removals: [],
    });
    const updated = applied.session?.windows[0];
    expect(updated).not.toBe(source);
    expect(updated?.name).toBe('renamed');
    expect(updated?.panes).toBe(source?.panes);
    expect(applied.session?.windows[1]).toBe(current.session?.windows[1]);
  });

  test('移除 window 后同名 pane 的 upsert 会重新创建而不是复活旧对象', () => {
    const current = wideSnapshot(2, 2);
    const applied = applyLegacyStateSnapshotDiff(current, {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_PANE,
          nativeId: '%0-0',
          parentKind: SOURCE_ENTITY_WINDOW,
          parentId: '@1',
          fields: [],
        },
      ],
      removals: [{ entityKind: SOURCE_ENTITY_WINDOW, nativeId: '@0' }],
    });
    expect(applied.session?.windows.map((window) => window.id)).toEqual(['@1']);
    const moved = applied.session?.windows[0]?.panes.find((pane) => pane.id === '%0-0');
    expect(moved).toEqual({
      id: '%0-0',
      windowId: '@1',
      index: 0,
      active: false,
      width: 1,
      height: 1,
    });
  });

  test('session 被移除后同一批 upsert 重建出干净的会话', () => {
    const applied = applyLegacyStateSnapshotDiff(snapshot(), {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_SESSION,
          nativeId: '$2',
          parentKind: null,
          parentId: null,
          fields: [[SOURCE_FIELD_NAME, 'fresh']],
        },
        {
          entityKind: SOURCE_ENTITY_WINDOW,
          nativeId: '@9',
          parentKind: SOURCE_ENTITY_SESSION,
          parentId: '$2',
          fields: [[SOURCE_FIELD_NAME, 'w9']],
        },
      ],
      removals: [{ entityKind: SOURCE_ENTITY_SESSION, nativeId: '$1' }],
    });
    expect(applied.session?.id).toBe('$2');
    expect(applied.session?.name).toBe('fresh');
    expect(applied.session?.windows).toEqual([
      { id: '@9', name: 'w9', index: 0, active: false, panes: [] },
    ]);
  });

  test('不修改输入快照', () => {
    const current = wideSnapshot(2, 2);
    const before = structuredClone(current);
    applyLegacyStateSnapshotDiff(current, {
      upserts: [
        {
          entityKind: SOURCE_ENTITY_PANE,
          nativeId: '%0-0',
          parentKind: SOURCE_ENTITY_WINDOW,
          parentId: '@1',
          fields: [[SOURCE_FIELD_TITLE, 'x']],
        },
      ],
      removals: [{ entityKind: SOURCE_ENTITY_PANE, nativeId: '%1-1' }],
    });
    expect(current).toEqual(before);
  });
});
