// canonical 元数据 → tmux 树折叠的无 DOM 实现：浏览器 store 与 Node CLI 共用，
// 这里覆盖快照重建、增量增删改、server epoch 翻转、树顺序、自定义名与 pane epoch。

import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import type { MetadataPatchEvent, MetadataSnapshotEvent } from './canonical-state-helpers';
import {
  activePane,
  activeWindow,
  createCanonicalTree,
  findPaneById,
  findWindowByIndex,
  findWindowByName,
  resolvePane,
  resolveWindow,
} from './canonical-tree';

const DEVICE = 'device-a';
const SERVER_EPOCH = new Uint8Array(16).fill(0x11);
const NEXT_SERVER_EPOCH = new Uint8Array(16).fill(0x12);
const METADATA_EPOCH = new Uint8Array(16).fill(0x33);
const NEXT_METADATA_EPOCH = new Uint8Array(16).fill(0x34);
const PANE_EPOCH = new Uint8Array(16).fill(0x22);
const NEXT_PANE_EPOCH = new Uint8Array(16).fill(0x23);
const SNAPSHOT_ID = new Uint8Array(16).fill(0x44);

type Field = wsBorsh.SourceMetadataRecord['fields'][number];

function key(
  entityKind: number,
  nativeId: string,
  serverEpoch = SERVER_EPOCH
): wsBorsh.SourceEntityKey {
  return { deviceId: DEVICE, serverEpoch, entityKind, nativeId };
}

function sessionRecord(name = 'main'): wsBorsh.SourceMetadataRecord {
  return {
    key: key(wsBorsh.SOURCE_ENTITY_SESSION, '$1'),
    parent: null,
    fields: [{ field: wsBorsh.SOURCE_FIELD_NAME, value: { String: name } }],
  };
}

function windowRecord(
  windowId: string,
  index: number,
  extra: Field[] = [],
  serverEpoch = SERVER_EPOCH
): wsBorsh.SourceMetadataRecord {
  return {
    key: key(wsBorsh.SOURCE_ENTITY_WINDOW, windowId, serverEpoch),
    parent: null,
    fields: [
      { field: wsBorsh.SOURCE_FIELD_NAME, value: { String: `win${index}` } },
      { field: wsBorsh.SOURCE_FIELD_INDEX, value: { U32: index } },
      { field: wsBorsh.SOURCE_FIELD_ACTIVE, value: { Bool: index === 0 } },
      ...extra,
    ],
  };
}

function paneRecord(
  paneId: string,
  windowId: string,
  index: number,
  extra: Field[] = [],
  serverEpoch = SERVER_EPOCH
): wsBorsh.SourceMetadataRecord {
  return {
    key: key(wsBorsh.SOURCE_ENTITY_PANE, paneId, serverEpoch),
    parent: key(wsBorsh.SOURCE_ENTITY_WINDOW, windowId, serverEpoch),
    fields: [
      { field: wsBorsh.SOURCE_FIELD_INDEX, value: { U32: index } },
      { field: wsBorsh.SOURCE_FIELD_ACTIVE, value: { Bool: index === 0 } },
      { field: wsBorsh.SOURCE_FIELD_WIDTH, value: { U16: 80 } },
      { field: wsBorsh.SOURCE_FIELD_HEIGHT, value: { U16: 24 } },
      { field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Bytes16: PANE_EPOCH } },
      ...extra,
    ],
  };
}

function baseRecords(): wsBorsh.SourceMetadataRecord[] {
  return [
    sessionRecord(),
    windowRecord('@1', 0),
    windowRecord('@2', 1),
    paneRecord('%1', '@1', 0),
    paneRecord('%2', '@1', 1),
    paneRecord('%3', '@2', 0),
  ];
}

function snapshotEvent(
  records: wsBorsh.SourceMetadataRecord[],
  overrides: Partial<MetadataSnapshotEvent> = {}
): MetadataSnapshotEvent {
  return {
    metadataEpoch: METADATA_EPOCH,
    revision: 1n,
    snapshotId: SNAPSHOT_ID,
    chunkIndex: 0,
    totalChunks: 1,
    records,
    ...overrides,
  };
}

function patchEvent(
  fromRevision: bigint,
  throughRevision: bigint,
  upserts: wsBorsh.SourceMetadataRecord[],
  removals: wsBorsh.SourceEntityKey[] = []
): MetadataPatchEvent {
  return { metadataEpoch: METADATA_EPOCH, fromRevision, throughRevision, upserts, removals };
}

function seeded(onGap?: (deviceId?: string) => void) {
  const tree = createCanonicalTree(onGap ? { onGap } : {});
  expect(tree.applySnapshot(snapshotEvent(baseRecords()))).toEqual([DEVICE]);
  return tree;
}

function windowIds(tree: ReturnType<typeof createCanonicalTree>): string[] {
  return (tree.session(DEVICE)?.windows ?? []).map((window) => window.id);
}

describe('createCanonicalTree 快照折叠', () => {
  test('单片快照重建整棵树', () => {
    const tree = seeded();
    const session = tree.session(DEVICE);
    expect(session?.id).toBe('$1');
    expect(session?.name).toBe('main');
    expect(windowIds(tree)).toEqual(['@1', '@2']);
    expect(session?.windows[0]?.panes.map((pane) => pane.id)).toEqual(['%1', '%2']);
    expect(session?.windows[0]?.panes[0]).toMatchObject({
      windowId: '@1',
      index: 0,
      active: true,
      width: 80,
      height: 24,
    });
    expect(tree.get().map((item) => item.id)).toEqual(['$1']);
    expect(tree.deviceIds()).toEqual([DEVICE]);
    tree.dispose();
  });

  test('分片快照收齐前不出树，收齐后一次性重建', () => {
    const tree = createCanonicalTree();
    const records = baseRecords();
    const first = snapshotEvent(records.slice(0, 3), { chunkIndex: 0, totalChunks: 2 });
    const second = snapshotEvent(records.slice(3), { chunkIndex: 1, totalChunks: 2 });
    expect(tree.applySnapshot(first)).toEqual([]);
    expect(tree.session(DEVICE)).toBeNull();
    expect(tree.applySnapshot(second)).toEqual([DEVICE]);
    expect(windowIds(tree)).toEqual(['@1', '@2']);
    tree.dispose();
  });

  test('分片越界即报断链，不写入半棵树', () => {
    const gaps: Array<string | undefined> = [];
    const tree = createCanonicalTree({ onGap: (deviceId) => gaps.push(deviceId) });
    expect(tree.applySnapshot(snapshotEvent([], { chunkIndex: 3, totalChunks: 2 }))).toEqual([]);
    expect(gaps).toEqual([undefined]);
    expect(tree.deviceIds()).toEqual([]);
    tree.dispose();
  });

  test('新快照整棵替换旧树，reset 清空设备', () => {
    const tree = seeded();
    const replaced = tree.applySnapshot(
      snapshotEvent([sessionRecord('other'), windowRecord('@9', 0)], {
        revision: 7n,
        snapshotId: new Uint8Array(16).fill(0x45),
      })
    );
    expect(replaced).toEqual([DEVICE]);
    expect(windowIds(tree)).toEqual(['@9']);
    expect(tree.device(DEVICE)?.revision).toBe(7n);
    tree.reset(DEVICE);
    expect(tree.deviceIds()).toEqual([]);
    tree.dispose();
  });
});

describe('createCanonicalTree 增量折叠', () => {
  test('新增窗口与 pane', () => {
    const tree = seeded();
    const changed = tree.applyPatch(
      patchEvent(1n, 2n, [windowRecord('@3', 2), paneRecord('%4', '@3', 0)])
    );
    expect(changed).toEqual([DEVICE]);
    expect(windowIds(tree)).toEqual(['@1', '@2', '@3']);
    expect(findPaneById(tree.session(DEVICE), '%4')?.windowId).toBe('@3');
    expect(tree.device(DEVICE)?.revision).toBe(2n);
    tree.dispose();
  });

  test('更新只带变化字段，未带的字段保持原值', () => {
    const tree = seeded();
    tree.applyPatch(
      patchEvent(1n, 2n, [
        {
          key: key(wsBorsh.SOURCE_ENTITY_WINDOW, '@2'),
          parent: null,
          fields: [{ field: wsBorsh.SOURCE_FIELD_NAME, value: { String: 'renamed' } }],
        },
      ])
    );
    const window = findWindowByIndex(tree.session(DEVICE), 1);
    expect(window?.name).toBe('renamed');
    expect(window?.index).toBe(1);
    tree.dispose();
  });

  test('删除窗口连同其 pane 一起消失', () => {
    const tree = seeded();
    tree.applyPatch(patchEvent(1n, 2n, [], [key(wsBorsh.SOURCE_ENTITY_WINDOW, '@1')]));
    expect(windowIds(tree)).toEqual(['@2']);
    expect(findPaneById(tree.session(DEVICE), '%1')).toBeNull();
    tree.dispose();
  });

  test('删除单个 pane 只摘掉该 pane', () => {
    const tree = seeded();
    tree.applyPatch(patchEvent(1n, 2n, [], [key(wsBorsh.SOURCE_ENTITY_PANE, '%2')]));
    expect(tree.session(DEVICE)?.windows[0]?.panes.map((pane) => pane.id)).toEqual(['%1']);
    expect(tree.device(DEVICE)?.paneEpochs.has('%2')).toBe(false);
    tree.dispose();
  });

  test('revision 或 metadata epoch 对不上只报断链，不动树', () => {
    const gaps: Array<string | undefined> = [];
    const tree = seeded((deviceId) => gaps.push(deviceId));
    expect(tree.applyPatch(patchEvent(5n, 6n, [windowRecord('@7', 3)]))).toEqual([]);
    expect(
      tree.applyPatch({
        ...patchEvent(1n, 2n, [windowRecord('@7', 3)]),
        metadataEpoch: NEXT_METADATA_EPOCH,
      })
    ).toEqual([]);
    expect(gaps).toEqual([DEVICE, DEVICE]);
    expect(windowIds(tree)).toEqual(['@1', '@2']);
    tree.dispose();
  });

  test('throughRevision 倒退按全局断链处理', () => {
    const gaps: Array<string | undefined> = [];
    const tree = seeded((deviceId) => gaps.push(deviceId));
    expect(tree.applyPatch(patchEvent(3n, 2n, []))).toEqual([]);
    expect(gaps).toEqual([undefined]);
    tree.dispose();
  });
});

describe('createCanonicalTree 身份与顺序', () => {
  test('server epoch 翻转后换新 epoch 并清空旧 pane epoch', () => {
    const tree = seeded();
    expect(tree.device(DEVICE)?.paneEpochs.get('%1')).toEqual(PANE_EPOCH);
    tree.applyPatch(patchEvent(1n, 2n, [windowRecord('@5', 0, [], NEXT_SERVER_EPOCH)], []));
    const device = tree.device(DEVICE);
    expect(device?.serverEpoch).toEqual(NEXT_SERVER_EPOCH);
    expect(device?.paneEpochs.size).toBe(0);
    tree.dispose();
  });

  test('pane epoch 变化写进账本，Unset 摘掉条目', () => {
    const tree = seeded();
    tree.applyPatch(
      patchEvent(1n, 2n, [
        {
          key: key(wsBorsh.SOURCE_ENTITY_PANE, '%1'),
          parent: key(wsBorsh.SOURCE_ENTITY_WINDOW, '@1'),
          fields: [{ field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Bytes16: NEXT_PANE_EPOCH } }],
        },
      ])
    );
    expect(tree.device(DEVICE)?.paneEpochs.get('%1')).toEqual(NEXT_PANE_EPOCH);
    tree.applyPatch(
      patchEvent(2n, 3n, [
        {
          key: key(wsBorsh.SOURCE_ENTITY_PANE, '%1'),
          parent: key(wsBorsh.SOURCE_ENTITY_WINDOW, '@1'),
          fields: [{ field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Unset: {} } }],
        },
      ])
    );
    expect(tree.device(DEVICE)?.paneEpochs.has('%1')).toBe(false);
    tree.dispose();
  });

  test('TREE_ORDER 重排窗口，Unset 后退回 tmux index 顺序', () => {
    const tree = createCanonicalTree();
    tree.applySnapshot(
      snapshotEvent([
        sessionRecord(),
        windowRecord('@1', 0, [{ field: wsBorsh.SOURCE_FIELD_TREE_ORDER, value: { U32: 2 } }]),
        windowRecord('@2', 1, [{ field: wsBorsh.SOURCE_FIELD_TREE_ORDER, value: { U32: 1 } }]),
      ])
    );
    expect(windowIds(tree)).toEqual(['@2', '@1']);
    tree.applyPatch(
      patchEvent(1n, 2n, [
        {
          key: key(wsBorsh.SOURCE_ENTITY_WINDOW, '@1'),
          parent: null,
          fields: [{ field: wsBorsh.SOURCE_FIELD_TREE_ORDER, value: { Unset: {} } }],
        },
        {
          key: key(wsBorsh.SOURCE_ENTITY_WINDOW, '@2'),
          parent: null,
          fields: [{ field: wsBorsh.SOURCE_FIELD_TREE_ORDER, value: { Unset: {} } }],
        },
      ])
    );
    expect(windowIds(tree)).toEqual(['@1', '@2']);
    tree.dispose();
  });

  test('自定义名覆盖 tmux 名，Unset 后回落', () => {
    const tree = createCanonicalTree();
    tree.applySnapshot(
      snapshotEvent([
        sessionRecord(),
        windowRecord('@1', 0, [
          { field: wsBorsh.SOURCE_FIELD_CUSTOM_NAME, value: { String: 'editor' } },
        ]),
        paneRecord('%1', '@1', 0, [
          { field: wsBorsh.SOURCE_FIELD_CUSTOM_NAME, value: { String: 'server' } },
          { field: wsBorsh.SOURCE_FIELD_TITLE, value: { String: 'bash' } },
        ]),
      ])
    );
    expect(findWindowByName(tree.session(DEVICE), 'editor')?.id).toBe('@1');
    expect(findPaneById(tree.session(DEVICE), '%1')?.customName).toBe('server');
    tree.applyPatch(
      patchEvent(1n, 2n, [
        {
          key: key(wsBorsh.SOURCE_ENTITY_WINDOW, '@1'),
          parent: null,
          fields: [{ field: wsBorsh.SOURCE_FIELD_CUSTOM_NAME, value: { Unset: {} } }],
        },
      ])
    );
    expect(tree.session(DEVICE)?.windows[0]?.customName).toBeUndefined();
    expect(findWindowByName(tree.session(DEVICE), 'win0')?.id).toBe('@1');
    tree.dispose();
  });

  test('多设备各自成树，get() 按 deviceId 排序', () => {
    const tree = createCanonicalTree();
    const other = 'device-b';
    const foreign = baseRecords().map((record) => ({
      ...record,
      key: { ...record.key, deviceId: other },
      parent: record.parent ? { ...record.parent, deviceId: other } : null,
    }));
    tree.applySnapshot(snapshotEvent([...foreign, ...baseRecords()]));
    expect(tree.deviceIds()).toEqual([DEVICE, other]);
    expect(tree.get()).toHaveLength(2);
    tree.reset();
    expect(tree.get()).toEqual([]);
    tree.dispose();
  });
});

describe('纯定位辅助', () => {
  test('按 id / index / 名字定位窗口与 pane', () => {
    const tree = seeded();
    const session = tree.session(DEVICE);
    expect(resolveWindow(session, '@2')?.id).toBe('@2');
    expect(resolveWindow(session, '1')?.id).toBe('@2');
    expect(resolveWindow(session, 'win1')?.id).toBe('@2');
    expect(resolveWindow(session, 'missing')).toBeNull();
    expect(resolvePane(session, '%3')?.id).toBe('%3');
    expect(resolvePane(session, '1.0')?.id).toBe('%3');
    expect(resolvePane(session, '1')?.id).toBe('%2');
    expect(resolvePane(session, '@2.0')?.id).toBe('%3');
    expect(resolvePane(session, '9.0')).toBeNull();
    tree.dispose();
  });

  test('活动窗口与活动 pane 缺省回落到第一个', () => {
    const tree = seeded();
    const session = tree.session(DEVICE);
    expect(activeWindow(session)?.id).toBe('@1');
    expect(activePane(activeWindow(session))?.id).toBe('%1');
    expect(activeWindow(null)).toBeNull();
    expect(activePane(null)).toBeNull();
    tree.dispose();
  });

  test('pane 名定位优先活动窗口，再扫其余窗口', () => {
    const tree = createCanonicalTree();
    tree.applySnapshot(
      snapshotEvent([
        sessionRecord(),
        windowRecord('@1', 0),
        windowRecord('@2', 1),
        paneRecord('%1', '@1', 0, [
          { field: wsBorsh.SOURCE_FIELD_CUSTOM_NAME, value: { String: 'shared' } },
        ]),
        paneRecord('%2', '@2', 0, [
          { field: wsBorsh.SOURCE_FIELD_CUSTOM_NAME, value: { String: 'shared' } },
        ]),
        paneRecord('%3', '@2', 1, [
          { field: wsBorsh.SOURCE_FIELD_CUSTOM_NAME, value: { String: 'only-here' } },
        ]),
      ])
    );
    const session = tree.session(DEVICE);
    expect(resolvePane(session, 'shared')?.id).toBe('%1');
    expect(resolvePane(session, 'only-here')?.id).toBe('%3');
    expect(resolvePane(session, 'nope')).toBeNull();
    tree.dispose();
  });
});
