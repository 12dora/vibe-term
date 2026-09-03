// canonical v1.1 树顺序在客户端的增量维护：diff 必须落在未排序底稿上，
// 否则顺序被 Unset 后退不回 tmux index 顺序（老的自定义顺序会粘住）。

import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
  type MetadataLiveCaches,
  ingestMetadataPatch,
  ingestMetadataSnapshot,
} from './canonical-metadata-identity';
import type { DeviceMetadataState, MetadataPatchEvent } from './canonical-state-helpers';

const DEVICE = 'device-a';
const SERVER_EPOCH = new Uint8Array(16).fill(0x11);
const METADATA_EPOCH = new Uint8Array(16).fill(0x33);

function key(entityKind: number, nativeId: string): wsBorsh.SourceEntityKey {
  return { deviceId: DEVICE, serverEpoch: SERVER_EPOCH, entityKind, nativeId };
}

function sessionRecord(): wsBorsh.SourceMetadataRecord {
  return {
    key: key(wsBorsh.SOURCE_ENTITY_SESSION, '$1'),
    parent: null,
    fields: [{ field: wsBorsh.SOURCE_FIELD_NAME, value: { String: 'main' } }],
  };
}

function windowRecord(
  windowId: string,
  index: number,
  treeOrder?: number | 'unset'
): wsBorsh.SourceMetadataRecord {
  const fields: wsBorsh.SourceMetadataRecord['fields'] = [
    { field: wsBorsh.SOURCE_FIELD_NAME, value: { String: windowId } },
    { field: wsBorsh.SOURCE_FIELD_INDEX, value: { U32: index } },
  ];
  if (treeOrder === 'unset') {
    fields.push({ field: wsBorsh.SOURCE_FIELD_TREE_ORDER, value: { Unset: {} } });
  } else if (treeOrder !== undefined) {
    fields.push({ field: wsBorsh.SOURCE_FIELD_TREE_ORDER, value: { U32: treeOrder } });
  }
  return { key: key(wsBorsh.SOURCE_ENTITY_WINDOW, windowId), parent: null, fields };
}

function paneRecord(paneId: string, windowId: string, index: number) {
  return {
    key: key(wsBorsh.SOURCE_ENTITY_PANE, paneId),
    parent: key(wsBorsh.SOURCE_ENTITY_WINDOW, windowId),
    fields: [{ field: wsBorsh.SOURCE_FIELD_INDEX, value: { U32: index } }],
  } satisfies wsBorsh.SourceMetadataRecord;
}

function baseRecords(): wsBorsh.SourceMetadataRecord[] {
  return [
    sessionRecord(),
    windowRecord('@1', 0),
    windowRecord('@2', 1),
    windowRecord('@3', 2),
    paneRecord('%1', '@1', 0),
    paneRecord('%2', '@1', 1),
  ];
}

function harness(): {
  caches: MetadataLiveCaches;
  state: () => DeviceMetadataState;
  patch: (revision: bigint, records: wsBorsh.SourceMetadataRecord[]) => void;
  windowIds: () => string[];
  paneIds: () => string[];
} {
  const metadata = new Map<string, DeviceMetadataState>();
  const noop = () => {};
  const caches: MetadataLiveCaches = {
    metadata,
    awaitingMetadataDevices: new Set(),
    epochRecoveryDevices: new Set(),
    terminalCursors: new Map(),
    blockedPanes: new Set(),
    clearPaneStateForDevice: noop,
    cancelPane: noop,
    dropPendingPane: noop,
    dropSizeEpoch: noop,
    resolvedRecovery: noop,
    resolvedSubscriptionRetry: noop,
    emitSnapshot: noop,
    emitPatch: noop,
    emitMetadataGap: noop,
  };
  const state = () => {
    const found = metadata.get(DEVICE);
    if (!found) throw new Error('missing device metadata');
    return found;
  };
  return {
    caches,
    state,
    patch: (revision, records) => {
      const event: MetadataPatchEvent = {
        metadataEpoch: METADATA_EPOCH,
        fromRevision: revision - 1n,
        throughRevision: revision,
        upserts: records,
        removals: [],
      };
      expect(ingestMetadataPatch(caches, event)).toBe('applied');
    },
    windowIds: () => (state().snapshot.session?.windows ?? []).map((window) => window.id),
    paneIds: () =>
      (state().snapshot.session?.windows ?? []).flatMap((window) =>
        window.panes.map((pane) => pane.id)
      ),
  };
}

function seed(caches: MetadataLiveCaches): void {
  ingestMetadataSnapshot(caches, METADATA_EPOCH, 1n, baseRecords());
}

describe('canonical tree order 在客户端的增量维护', () => {
  test('首帧无顺序时按 tmux index 顺序展示', () => {
    const h = harness();
    seed(h.caches);
    expect(h.windowIds()).toEqual(['@1', '@2', '@3']);
    expect(h.state().snapshot).toBe(h.state().baseSnapshot);
  });

  test('设顺序 → 部分改动 → 全量 Unset 后回到 tmux index 顺序', () => {
    const h = harness();
    seed(h.caches);

    // 1) 设自定义顺序：反序
    h.patch(2n, [windowRecord('@1', 0, 2), windowRecord('@2', 1, 1), windowRecord('@3', 2, 0)]);
    expect(h.windowIds()).toEqual(['@3', '@2', '@1']);

    // 2) 只把 @3 退出自定义顺序：剩下两个仍按序号，@3 回到底稿位置（末尾）
    h.patch(3n, [windowRecord('@3', 2, 'unset')]);
    expect(h.windowIds()).toEqual(['@2', '@1', '@3']);

    // 3) 全量 Unset：顺序表空，必须退回 tmux index 顺序而不是粘住上一次的自定义顺序
    h.patch(4n, [windowRecord('@1', 0, 'unset'), windowRecord('@2', 1, 'unset')]);
    expect(h.state().treeOrder.windows.size).toBe(0);
    expect(h.windowIds()).toEqual(['@1', '@2', '@3']);
  });

  test('pane 顺序同样可以完整退回', () => {
    const h = harness();
    seed(h.caches);
    expect(h.paneIds()).toEqual(['%1', '%2']);

    h.patch(2n, [
      {
        ...paneRecord('%1', '@1', 0),
        fields: [{ field: wsBorsh.SOURCE_FIELD_TREE_ORDER, value: { U32: 1 } }],
      },
      {
        ...paneRecord('%2', '@1', 1),
        fields: [{ field: wsBorsh.SOURCE_FIELD_TREE_ORDER, value: { U32: 0 } }],
      },
    ]);
    expect(h.paneIds()).toEqual(['%2', '%1']);

    h.patch(3n, [
      {
        ...paneRecord('%1', '@1', 0),
        fields: [{ field: wsBorsh.SOURCE_FIELD_TREE_ORDER, value: { Unset: {} } }],
      },
      {
        ...paneRecord('%2', '@1', 1),
        fields: [{ field: wsBorsh.SOURCE_FIELD_TREE_ORDER, value: { Unset: {} } }],
      },
    ]);
    expect(h.state().treeOrder.panes.size).toBe(0);
    expect(h.paneIds()).toEqual(['%1', '%2']);
  });

  test('底稿保持 tmux index 顺序，展示视图才带自定义顺序', () => {
    const h = harness();
    seed(h.caches);
    h.patch(2n, [windowRecord('@1', 0, 2), windowRecord('@3', 2, 0)]);
    expect((h.state().baseSnapshot.session?.windows ?? []).map((w) => w.id)).toEqual([
      '@1',
      '@2',
      '@3',
    ]);
    expect(h.windowIds()).toEqual(['@3', '@1', '@2']);
  });
});
