import { describe, expect, test } from 'bun:test';

import type { StateSnapshotPayload, TmuxPane, TmuxWindow } from '../index';
import {
  SOURCE_ENTITY_PANE,
  SOURCE_ENTITY_SESSION,
  SOURCE_ENTITY_WINDOW,
  SOURCE_FIELD_INDEX,
  SOURCE_FIELD_NAME,
  SOURCE_FIELD_TREE_ORDER,
  type SourceEntityKey,
  type SourceMetadataRecord,
} from './canonical-state';
import {
  applyCanonicalTreeOrderPatch,
  createCanonicalTreeOrder,
  sortSnapshotByCanonicalTreeOrder,
} from './canonical-tree-order';
import {
  applyLegacyStateSnapshotDiff,
  sourceMetadataPatchToLegacyDiff,
} from './state-snapshot-diff';

const ZERO_16 = new Uint8Array(16);
const DEVICE = 'device-a';

function key(entityKind: number, nativeId: string): SourceEntityKey {
  return { deviceId: DEVICE, serverEpoch: ZERO_16, entityKind, nativeId };
}

function record(
  entityKind: number,
  nativeId: string,
  fields: SourceMetadataRecord['fields']
): SourceMetadataRecord {
  return { key: key(entityKind, nativeId), parent: null, fields };
}

function treeOrderRecord(entityKind: number, nativeId: string, order: number) {
  return record(entityKind, nativeId, [{ field: SOURCE_FIELD_TREE_ORDER, value: { U32: order } }]);
}

function unsetRecord(entityKind: number, nativeId: string) {
  return record(entityKind, nativeId, [{ field: SOURCE_FIELD_TREE_ORDER, value: { Unset: {} } }]);
}

function pane(id: string, windowId: string, index: number): TmuxPane {
  return { id, windowId, index, active: false, width: 80, height: 24 };
}

function window(id: string, index: number, paneIds: string[]): TmuxWindow {
  return {
    id,
    name: id,
    index,
    active: false,
    panes: paneIds.map((paneId, position) => pane(paneId, id, position)),
  };
}

function snapshot(windows: TmuxWindow[]): StateSnapshotPayload {
  return { deviceId: DEVICE, session: { id: '$0', name: 'main', windows } };
}

function windowIds(payload: StateSnapshotPayload): string[] {
  return (payload.session?.windows ?? []).map((item) => item.id);
}

function paneIds(payload: StateSnapshotPayload, windowId: string): string[] {
  const target = payload.session?.windows.find((item) => item.id === windowId);
  return (target?.panes ?? []).map((item) => item.id);
}

// legacy overlay 的参考实现（apps/gateway/src/ws/overlay-utils.ts orderBySaved），
// 用来证明 canonical 顺序字段与被替换的 overlay 语义完全等价。
function orderBySaved<T>(items: T[], idOf: (item: T) => string, savedIds: string[]): T[] {
  if (savedIds.length === 0) return items;
  const byId = new Map(items.map((item) => [idOf(item), item] as const));
  const used = new Set<string>();
  const result: T[] = [];
  for (const id of savedIds) {
    const item = byId.get(id);
    if (item && !used.has(id)) {
      result.push(item);
      used.add(id);
    }
  }
  for (const item of items) {
    if (!used.has(idOf(item))) result.push(item);
  }
  return result;
}

describe('canonical tree order 顺序表', () => {
  test('快照记录直接构造顺序表', () => {
    const order = createCanonicalTreeOrder([
      treeOrderRecord(SOURCE_ENTITY_WINDOW, '@2', 0),
      treeOrderRecord(SOURCE_ENTITY_WINDOW, '@1', 1),
      treeOrderRecord(SOURCE_ENTITY_PANE, '%5', 0),
      record(SOURCE_ENTITY_SESSION, '$0', [{ field: SOURCE_FIELD_TREE_ORDER, value: { U32: 3 } }]),
    ]);
    expect([...order.windows]).toEqual([
      ['@2', 0],
      ['@1', 1],
    ]);
    expect([...order.panes]).toEqual([['%5', 0]]);
  });

  test('patch 只带变化字段：没带 TREE_ORDER 视为未变', () => {
    const order = createCanonicalTreeOrder([treeOrderRecord(SOURCE_ENTITY_WINDOW, '@1', 4)]);
    const changed = applyCanonicalTreeOrderPatch(
      order,
      [record(SOURCE_ENTITY_WINDOW, '@1', [{ field: SOURCE_FIELD_INDEX, value: { U32: 9 } }])],
      []
    );
    expect(changed).toBe(false);
    expect(order.windows.get('@1')).toBe(4);
  });

  test('Unset 清除序号，实体删除同样清除', () => {
    const order = createCanonicalTreeOrder([
      treeOrderRecord(SOURCE_ENTITY_WINDOW, '@1', 0),
      treeOrderRecord(SOURCE_ENTITY_PANE, '%1', 0),
    ]);
    expect(applyCanonicalTreeOrderPatch(order, [unsetRecord(SOURCE_ENTITY_WINDOW, '@1')], [])).toBe(
      true
    );
    expect(order.windows.has('@1')).toBe(false);
    expect(applyCanonicalTreeOrderPatch(order, [], [key(SOURCE_ENTITY_PANE, '%1')])).toBe(true);
    expect(order.panes.has('%1')).toBe(false);
    expect(applyCanonicalTreeOrderPatch(order, [], [key(SOURCE_ENTITY_PANE, '%1')])).toBe(false);
  });

  test('相同序号重复下发不算变化', () => {
    const order = createCanonicalTreeOrder([treeOrderRecord(SOURCE_ENTITY_WINDOW, '@1', 2)]);
    expect(
      applyCanonicalTreeOrderPatch(order, [treeOrderRecord(SOURCE_ENTITY_WINDOW, '@1', 2)], [])
    ).toBe(false);
    expect(
      applyCanonicalTreeOrderPatch(order, [treeOrderRecord(SOURCE_ENTITY_WINDOW, '@1', 3)], [])
    ).toBe(true);
  });
});

describe('canonical tree order 快照重排', () => {
  const base = snapshot([
    window('@1', 0, ['%1', '%2']),
    window('@2', 1, ['%3']),
    window('@3', 2, ['%4', '%5']),
  ]);

  test('空顺序表返回同一引用', () => {
    expect(sortSnapshotByCanonicalTreeOrder(base, createCanonicalTreeOrder())).toBe(base);
  });

  test('顺序与现状一致时返回同一引用', () => {
    const order = createCanonicalTreeOrder([
      treeOrderRecord(SOURCE_ENTITY_WINDOW, '@1', 0),
      treeOrderRecord(SOURCE_ENTITY_WINDOW, '@2', 1),
      treeOrderRecord(SOURCE_ENTITY_WINDOW, '@3', 2),
    ]);
    expect(sortSnapshotByCanonicalTreeOrder(base, order)).toBe(base);
  });

  test('window 与 pane 分别按序号升序重排', () => {
    const order = createCanonicalTreeOrder([
      treeOrderRecord(SOURCE_ENTITY_WINDOW, '@3', 0),
      treeOrderRecord(SOURCE_ENTITY_WINDOW, '@1', 1),
      treeOrderRecord(SOURCE_ENTITY_WINDOW, '@2', 2),
      treeOrderRecord(SOURCE_ENTITY_PANE, '%5', 0),
      treeOrderRecord(SOURCE_ENTITY_PANE, '%4', 1),
    ]);
    const sorted = sortSnapshotByCanonicalTreeOrder(base, order);
    expect(windowIds(sorted)).toEqual(['@3', '@1', '@2']);
    expect(paneIds(sorted, '@3')).toEqual(['%5', '%4']);
    expect(paneIds(sorted, '@1')).toEqual(['%1', '%2']);
    expect(base.session?.windows.map((item) => item.id)).toEqual(['@1', '@2', '@3']);
  });

  test('没有序号的实体保持原顺序追加在后', () => {
    const order = createCanonicalTreeOrder([treeOrderRecord(SOURCE_ENTITY_WINDOW, '@3', 0)]);
    expect(windowIds(sortSnapshotByCanonicalTreeOrder(base, order))).toEqual(['@3', '@1', '@2']);
  });

  test('已消失的序号被忽略', () => {
    const order = createCanonicalTreeOrder([
      treeOrderRecord(SOURCE_ENTITY_WINDOW, '@9', 0),
      treeOrderRecord(SOURCE_ENTITY_WINDOW, '@2', 1),
    ]);
    expect(windowIds(sortSnapshotByCanonicalTreeOrder(base, order))).toEqual(['@2', '@1', '@3']);
  });

  test('未重排的 window 对象保持引用不变', () => {
    const order = createCanonicalTreeOrder([treeOrderRecord(SOURCE_ENTITY_PANE, '%2', 0)]);
    const sorted = sortSnapshotByCanonicalTreeOrder(base, order);
    expect(sorted).not.toBe(base);
    expect(sorted.session?.windows[1]).toBe(base.session?.windows[1]);
    expect(sorted.session?.windows[2]).toBe(base.session?.windows[2]);
    expect(paneIds(sorted, '@1')).toEqual(['%2', '%1']);
  });

  test('session 为 null 时原样返回', () => {
    const empty: StateSnapshotPayload = { deviceId: DEVICE, session: null };
    const order = createCanonicalTreeOrder([treeOrderRecord(SOURCE_ENTITY_WINDOW, '@1', 0)]);
    expect(sortSnapshotByCanonicalTreeOrder(empty, order)).toBe(empty);
  });

  test('与 legacy overlay 的 orderBySaved 在随机用例上等价', () => {
    let seed = 0x2f6e2b1;
    const nextInt = (bound: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % bound;
    };
    for (let round = 0; round < 200; round += 1) {
      const liveWindows = ['@1', '@2', '@3', '@4'].slice(0, 2 + nextInt(3));
      const savedWindows: string[] = [];
      for (const id of ['@4', '@1', '@9', '@3', '@2']) {
        if (nextInt(2) === 0) savedWindows.push(id);
      }
      const payload = snapshot(liveWindows.map((id, index) => window(id, index, [])));
      const order = createCanonicalTreeOrder(
        savedWindows.map((id, index) => treeOrderRecord(SOURCE_ENTITY_WINDOW, id, index))
      );
      const expected = orderBySaved(
        payload.session?.windows ?? [],
        (item) => item.id,
        savedWindows
      ).map((item) => item.id);
      expect(windowIds(sortSnapshotByCanonicalTreeOrder(payload, order))).toEqual(expected);
    }
  });
});

describe('TREE_ORDER 字段对 v1 消费方向前兼容', () => {
  test('legacy 投影忽略未知字段号，不污染 window / pane', () => {
    const diff = sourceMetadataPatchToLegacyDiff({
      metadataEpoch: ZERO_16,
      fromRevision: 0n,
      throughRevision: 1n,
      upserts: [
        {
          key: key(SOURCE_ENTITY_SESSION, '$0'),
          parent: null,
          fields: [{ field: SOURCE_FIELD_NAME, value: { String: 'main' } }],
        },
        {
          key: key(SOURCE_ENTITY_WINDOW, '@1'),
          parent: key(SOURCE_ENTITY_SESSION, '$0'),
          fields: [
            { field: SOURCE_FIELD_NAME, value: { String: 'zsh' } },
            { field: SOURCE_FIELD_TREE_ORDER, value: { U32: 3 } },
          ],
        },
        {
          key: key(SOURCE_ENTITY_PANE, '%1'),
          parent: key(SOURCE_ENTITY_WINDOW, '@1'),
          fields: [
            { field: SOURCE_FIELD_INDEX, value: { U32: 0 } },
            { field: SOURCE_FIELD_TREE_ORDER, value: { U32: 1 } },
          ],
        },
      ],
      removals: [],
    });
    expect(diff.upserts[1]?.fields).toContainEqual([SOURCE_FIELD_TREE_ORDER, 3]);

    const applied = applyLegacyStateSnapshotDiff({ deviceId: DEVICE, session: null }, diff);
    const target = applied.session?.windows[0];
    expect(target?.name).toBe('zsh');
    expect(Object.keys(target ?? {}).sort()).toEqual(['active', 'id', 'index', 'name', 'panes']);
    expect(Object.keys(target?.panes[0] ?? {}).sort()).toEqual([
      'active',
      'height',
      'id',
      'index',
      'width',
      'windowId',
    ]);
  });
});
