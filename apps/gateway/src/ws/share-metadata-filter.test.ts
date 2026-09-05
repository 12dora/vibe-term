import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
  ShareMetadataView,
  filterMetadataRecordsForShare,
  filterSnapshotForShare,
} from './share-metadata-filter';
import type { ShareScope } from './share-scope';

const SCOPE: ShareScope = { shareId: 'sh1', deviceId: 'device-a', windowId: '@1' };
const SERVER_EPOCH = new Uint8Array(16).fill(0x11);
const PANE_EPOCH = new Uint8Array(16).fill(0x22);

function key(entityKind: number, nativeId: string): wsBorsh.SourceEntityKey {
  return { deviceId: SCOPE.deviceId, serverEpoch: SERVER_EPOCH, entityKind, nativeId };
}

function record(
  entityKind: number,
  nativeId: string,
  parent: wsBorsh.SourceEntityKey | null,
  fields: wsBorsh.SourceMetadataRecord['fields'] = []
): wsBorsh.SourceMetadataRecord {
  return { key: key(entityKind, nativeId), parent, fields };
}

const deviceKey = key(wsBorsh.SOURCE_ENTITY_DEVICE, SCOPE.deviceId);
const serverKey = key(wsBorsh.SOURCE_ENTITY_SERVER, '$server');
const sessionKey = key(wsBorsh.SOURCE_ENTITY_SESSION, '$0');
const windowKey = key(wsBorsh.SOURCE_ENTITY_WINDOW, '@1');
const otherWindowKey = key(wsBorsh.SOURCE_ENTITY_WINDOW, '@2');

function tree(): wsBorsh.SourceMetadataRecord[] {
  return [
    record(wsBorsh.SOURCE_ENTITY_DEVICE, SCOPE.deviceId, null, [
      { field: wsBorsh.SOURCE_FIELD_NAME, value: { String: 'macbook' } },
      { field: wsBorsh.SOURCE_FIELD_CONNECTED, value: { Bool: true } },
    ]),
    record(wsBorsh.SOURCE_ENTITY_SERVER, '$server', deviceKey),
    record(wsBorsh.SOURCE_ENTITY_SESSION, '$0', serverKey, [
      { field: wsBorsh.SOURCE_FIELD_NAME, value: { String: 'tmex' } },
    ]),
    record(wsBorsh.SOURCE_ENTITY_WINDOW, '@1', sessionKey, [
      { field: wsBorsh.SOURCE_FIELD_NAME, value: { String: 'build' } },
      { field: wsBorsh.SOURCE_FIELD_LAYOUT, value: { String: 'abcd,80x24,0,0' } },
    ]),
    record(wsBorsh.SOURCE_ENTITY_PANE, '%1', windowKey, [
      { field: wsBorsh.SOURCE_FIELD_WIDTH, value: { U16: 80 } },
      { field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Bytes16: PANE_EPOCH } },
    ]),
    record(wsBorsh.SOURCE_ENTITY_PANE, '%2', windowKey),
    record(wsBorsh.SOURCE_ENTITY_WINDOW, '@2', sessionKey, [
      { field: wsBorsh.SOURCE_FIELD_NAME, value: { String: 'secret' } },
    ]),
    record(wsBorsh.SOURCE_ENTITY_PANE, '%3', otherWindowKey),
  ];
}

function ids(records: readonly wsBorsh.SourceMetadataRecord[]): string[] {
  return records.map((item) => item.key.nativeId);
}

describe('filterMetadataRecordsForShare', () => {
  test('只保留 scope window 及其 pane，父链结构完整', () => {
    const { records, evicted } = filterMetadataRecordsForShare(tree(), SCOPE);
    expect(ids(records)).toEqual([SCOPE.deviceId, '$server', '$0', '@1', '%1', '%2']);
    expect(evicted.map((item) => item.nativeId)).toEqual(['%3']);
  });

  test('剥掉设备名与会话名，保留 window / pane 的展示与几何字段', () => {
    const { records } = filterMetadataRecordsForShare(tree(), SCOPE);
    const byId = new Map(records.map((item) => [item.key.nativeId, item]));
    expect(byId.get(SCOPE.deviceId)?.fields.map((item) => item.field)).toEqual([
      wsBorsh.SOURCE_FIELD_CONNECTED,
    ]);
    expect(byId.get('$0')?.fields).toEqual([]);
    expect(byId.get('@1')?.fields.map((item) => item.field)).toEqual([
      wsBorsh.SOURCE_FIELD_NAME,
      wsBorsh.SOURCE_FIELD_LAYOUT,
    ]);
    expect(byId.get('%1')?.fields.map((item) => item.field)).toEqual([
      wsBorsh.SOURCE_FIELD_WIDTH,
      wsBorsh.SOURCE_FIELD_PANE_EPOCH,
    ]);
  });
});

describe('filterSnapshotForShare', () => {
  test('保留 epoch 与 revision，只裁剪记录', () => {
    const snapshot = { metadataEpoch: new Uint8Array(16).fill(9), revision: 7n, records: tree() };
    const filtered = filterSnapshotForShare(snapshot, SCOPE);
    expect(filtered.metadataEpoch).toBe(snapshot.metadataEpoch);
    expect(filtered.revision).toBe(7n);
    expect(ids(filtered.records)).toEqual([SCOPE.deviceId, '$server', '$0', '@1', '%1', '%2']);
  });
});

function exposedView(): ShareMetadataView {
  const view = new ShareMetadataView(SCOPE);
  view.snapshot({ metadataEpoch: new Uint8Array(16).fill(9), revision: 1n, records: tree() });
  return view;
}

describe('ShareMetadataView.patch', () => {
  test('pane 被移出 window 时转成 removal，其他 window 的 upsert 直接丢弃', () => {
    const patch = {
      metadataEpoch: new Uint8Array(16).fill(9),
      fromRevision: 4n,
      throughRevision: 5n,
      upserts: [
        record(wsBorsh.SOURCE_ENTITY_PANE, '%1', windowKey),
        record(wsBorsh.SOURCE_ENTITY_PANE, '%2', otherWindowKey),
        record(wsBorsh.SOURCE_ENTITY_WINDOW, '@2', sessionKey),
      ],
      removals: [],
    };
    const filtered = exposedView().patch(patch);
    expect(ids(filtered.upserts)).toEqual(['%1']);
    expect(filtered.removals.map((item) => item.nativeId)).toEqual(['%2']);
    expect(filtered.fromRevision).toBe(4n);
    expect(filtered.throughRevision).toBe(5n);
  });

  test('从未下发过的 pane 移出 window 时不发 removal，patch 仍然保留', () => {
    const view = exposedView();
    const patch = {
      metadataEpoch: new Uint8Array(16).fill(9),
      fromRevision: 5n,
      throughRevision: 6n,
      upserts: [record(wsBorsh.SOURCE_ENTITY_PANE, '%7', otherWindowKey)],
      removals: [key(wsBorsh.SOURCE_ENTITY_PANE, '%8')],
    };
    const filtered = view.patch(patch);
    expect(filtered.upserts).toEqual([]);
    expect(filtered.removals).toEqual([]);
    expect(filtered.throughRevision).toBe(6n);
  });

  test('同一个 pane 只发一次 removal', () => {
    const view = exposedView();
    const patch = (revision: bigint) => ({
      metadataEpoch: new Uint8Array(16).fill(9),
      fromRevision: revision,
      throughRevision: revision + 1n,
      upserts: [],
      removals: [key(wsBorsh.SOURCE_ENTITY_PANE, '%1')],
    });
    expect(view.patch(patch(5n)).removals.map((item) => item.nativeId)).toEqual(['%1']);
    expect(view.patch(patch(6n)).removals).toEqual([]);
  });

  test('pane 移入 window 时随 upsert 一并下发', () => {
    const patch = {
      metadataEpoch: new Uint8Array(16).fill(9),
      fromRevision: 5n,
      throughRevision: 6n,
      upserts: [record(wsBorsh.SOURCE_ENTITY_PANE, '%3', windowKey)],
      removals: [],
    };
    expect(ids(exposedView().patch(patch).upserts)).toEqual(['%3']);
  });

  test('只放行已下发过的 window removal', () => {
    const patch = {
      metadataEpoch: new Uint8Array(16).fill(9),
      fromRevision: 6n,
      throughRevision: 7n,
      upserts: [],
      removals: [otherWindowKey, windowKey, key(wsBorsh.SOURCE_ENTITY_PANE, '%1')],
    };
    const filtered = exposedView().patch(patch);
    expect(filtered.removals.map((item) => item.nativeId)).toEqual(['@1', '%1']);
  });
});

describe('ShareMetadataView.filterEvent', () => {
  const inScope = (_deviceId: string, paneId: string) => paneId === '%1';

  test('快照事件保留分片字段', () => {
    const event: wsBorsh.CanonicalEvent = {
      SourceMetadataSnapshot: {
        metadataEpoch: new Uint8Array(16).fill(9),
        revision: 3n,
        snapshotId: new Uint8Array(16).fill(8),
        chunkIndex: 1,
        totalChunks: 2,
        records: tree(),
      },
    };
    const filtered = new ShareMetadataView(SCOPE).filterEvent(event, inScope);
    if (!filtered || !('SourceMetadataSnapshot' in filtered)) throw new Error('expected snapshot');
    expect(filtered.SourceMetadataSnapshot.chunkIndex).toBe(1);
    expect(filtered.SourceMetadataSnapshot.totalChunks).toBe(2);
    expect(ids(filtered.SourceMetadataSnapshot.records)).toEqual([
      SCOPE.deviceId,
      '$server',
      '$0',
      '@1',
      '%1',
      '%2',
    ]);
  });

  test('scope 外 pane 的 PaneData 被丢弃', () => {
    const view = new ShareMetadataView(SCOPE);
    const paneData = (paneId: string): wsBorsh.CanonicalEvent => ({
      PaneData: {
        pane: { deviceId: SCOPE.deviceId, serverEpoch: SERVER_EPOCH, paneId },
        paneEpoch: PANE_EPOCH,
        seqStart: 0n,
        seqEnd: 1n,
        data: new Uint8Array([1]),
      },
    });
    expect(view.filterEvent(paneData('%9'), inScope)).toBeNull();
    expect(view.filterEvent(paneData('%1'), inScope)).not.toBeNull();
  });

  test('其余事件原样透传', () => {
    const event: wsBorsh.CanonicalEvent = {
      SourceGap: { scope: { Stream: {} }, reason: wsBorsh.SOURCE_GAP_REASON_EPOCH_CHANGED },
    };
    expect(new ShareMetadataView(SCOPE).filterEvent(event, inScope)).toBe(event);
  });
});
