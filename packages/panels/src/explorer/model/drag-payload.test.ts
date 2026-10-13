import { afterEach, describe, expect, test } from 'bun:test';
import { fileDownloadUrl } from '@vibeterm/api-client';
import {
  EXPLORER_DRAG_MIME,
  type ExplorerDragPayload,
  getActiveDrag,
  hasExplorerDrag,
  readDragPayload,
  resolveDropKind,
  setActiveDrag,
  writeDragPayload,
} from './drag-payload';

interface FakeDataTransfer {
  store: Map<string, string>;
  effectAllowed: string;
  types: string[];
  setData(type: string, value: string): void;
  getData(type: string): string;
}

function fakeDataTransfer(initial: Record<string, string> = {}): FakeDataTransfer {
  const store = new Map(Object.entries(initial));
  return {
    store,
    effectAllowed: 'uninitialized',
    get types() {
      return [...store.keys()];
    },
    setData(type, value) {
      store.set(type, value);
    },
    getData(type) {
      return store.get(type) ?? '';
    },
  };
}

const asDt = (value: unknown) => value as DataTransfer;

function payload(patch: Partial<ExplorerDragPayload> = {}): ExplorerDragPayload {
  return {
    nodeId: 'self',
    rootId: 'r1',
    deviceId: 'dev1',
    dir: '/root',
    paths: ['/root/a.txt'],
    names: ['a.txt'],
    hasDirectory: false,
    ...patch,
  };
}

const dest = (patch: Partial<Parameters<typeof resolveDropKind>[1]> = {}) => ({
  nodeId: 'self',
  deviceId: 'dev1',
  rootId: 'r1',
  dir: '/root/sub',
  ...patch,
});

describe('writeDragPayload', () => {
  test('a single file also gets the Chromium DownloadURL item', () => {
    const dt = fakeDataTransfer();
    const data = payload();
    writeDragPayload(asDt(dt), data, 'https://vt.example.com');
    expect(JSON.parse(dt.getData(EXPLORER_DRAG_MIME))).toEqual(data);
    expect(dt.effectAllowed).toBe('copyMove');
    expect(dt.getData('DownloadURL')).toBe(
      `application/octet-stream:a.txt:https://vt.example.com${fileDownloadUrl('self', 'r1', '/root/a.txt')}`
    );
  });

  test('a single directory has no DownloadURL', () => {
    const dt = fakeDataTransfer();
    writeDragPayload(
      asDt(dt),
      payload({ paths: ['/root/src'], names: ['src'], hasDirectory: true }),
      'https://vt.example.com'
    );
    expect(dt.store.has('DownloadURL')).toBe(false);
    expect(dt.effectAllowed).toBe('copyMove');
  });

  test('several items have no DownloadURL', () => {
    const dt = fakeDataTransfer();
    writeDragPayload(
      asDt(dt),
      payload({ paths: ['/root/a.txt', '/root/b.txt'], names: ['a.txt', 'b.txt'] }),
      'https://vt.example.com'
    );
    expect(dt.types).toEqual([EXPLORER_DRAG_MIME]);
  });

  test('the origin defaults without throwing outside a browser', () => {
    const dt = fakeDataTransfer();
    writeDragPayload(asDt(dt), payload());
    expect(dt.getData('DownloadURL')).toEndWith(fileDownloadUrl('self', 'r1', '/root/a.txt'));
  });
});

describe('readDragPayload', () => {
  test('round-trips what writeDragPayload wrote', () => {
    const dt = fakeDataTransfer();
    const data = payload({ paths: ['/root/a', '/root/b'], names: ['a', 'b'], hasDirectory: true });
    writeDragPayload(asDt(dt), data, '');
    expect(readDragPayload(asDt(dt))).toEqual(data);
  });

  test('drops unknown fields', () => {
    const dt = fakeDataTransfer({
      [EXPLORER_DRAG_MIME]: JSON.stringify({ ...payload(), extra: 1 }),
    });
    expect(readDragPayload(asDt(dt))).toEqual(payload());
  });

  test('returns null for anything malformed', () => {
    const read = (raw: string) =>
      readDragPayload(asDt(fakeDataTransfer({ [EXPLORER_DRAG_MIME]: raw })));
    expect(readDragPayload(asDt(fakeDataTransfer()))).toBeNull();
    expect(read('{not json')).toBeNull();
    expect(read('null')).toBeNull();
    expect(read('"text"')).toBeNull();
    expect(read('[]')).toBeNull();
    expect(read(JSON.stringify({ ...payload(), nodeId: 1 }))).toBeNull();
    expect(read(JSON.stringify({ ...payload(), dir: undefined }))).toBeNull();
    expect(read(JSON.stringify({ ...payload(), hasDirectory: 'no' }))).toBeNull();
    expect(read(JSON.stringify({ ...payload(), paths: 'a' }))).toBeNull();
    expect(read(JSON.stringify({ ...payload(), paths: [1] }))).toBeNull();
    expect(read(JSON.stringify({ ...payload(), names: null }))).toBeNull();
    expect(read(JSON.stringify({ ...payload(), paths: [], names: [] }))).toBeNull();
    expect(read(JSON.stringify({ ...payload(), names: ['a', 'b'] }))).toBeNull();
  });

  test('returns null when getData throws', () => {
    const dt = {
      getData() {
        throw new Error('protected mode');
      },
    };
    expect(readDragPayload(asDt(dt))).toBeNull();
  });
});

describe('hasExplorerDrag', () => {
  test('accepts arrays and DOMStringList-like objects', () => {
    expect(hasExplorerDrag(asDt({ types: ['text/plain', EXPLORER_DRAG_MIME] }))).toBe(true);
    expect(hasExplorerDrag(asDt({ types: { length: 1, 0: EXPLORER_DRAG_MIME } }))).toBe(true);
    expect(hasExplorerDrag(asDt({ types: ['Files'] }))).toBe(false);
    expect(hasExplorerDrag(asDt({ types: { length: 0 } }))).toBe(false);
  });
});

describe('active drag mirror', () => {
  afterEach(() => setActiveDrag(null));

  test('holds the payload between dragstart and dragend', () => {
    expect(getActiveDrag()).toBeNull();
    const data = payload();
    setActiveDrag(data);
    expect(getActiveDrag()).toBe(data);
    setActiveDrag(null);
    expect(getActiveDrag()).toBeNull();
  });
});

describe('resolveDropKind', () => {
  test('same node and device moves, the copy modifier copies', () => {
    expect(resolveDropKind(payload(), dest(), false)).toBe('move');
    expect(resolveDropKind(payload(), dest(), true)).toBe('copy');
    expect(resolveDropKind(payload(), dest({ rootId: 'r2', dir: '/other' }), false)).toBe('move');
  });

  test('another device or node always copies', () => {
    expect(resolveDropKind(payload(), dest({ deviceId: 'dev2', rootId: 'r2' }), false)).toBe(
      'copy'
    );
    expect(resolveDropKind(payload(), dest({ nodeId: 'n2' }), false)).toBe('copy');
    // 另一节点上恰好同名的 root / 设备 / 目录不算「原地」
    expect(resolveDropKind(payload(), dest({ nodeId: 'n2', dir: '/root' }), false)).toBe('copy');
  });

  test('dropping onto one of the dragged items is refused', () => {
    const data = payload({ paths: ['/root/src'], names: ['src'], hasDirectory: true });
    expect(resolveDropKind(data, dest({ dir: '/root/src' }), false)).toBe('none');
    expect(resolveDropKind(data, dest({ dir: '/root/src' }), true)).toBe('none');
    // hasDirectory 标记缺失时同样拒绝
    const unflagged = payload({ paths: ['/root/src'], names: ['src'] });
    expect(resolveDropKind(unflagged, dest({ dir: '/root/src' }), false)).toBe('none');
  });

  test('moving into the current directory is refused, copying is not', () => {
    expect(resolveDropKind(payload(), dest({ dir: '/root' }), false)).toBe('none');
    expect(resolveDropKind(payload(), dest({ dir: '/root' }), true)).toBe('copy');
    expect(resolveDropKind(payload(), dest({ dir: '/root', rootId: 'r2' }), false)).toBe('move');
    expect(resolveDropKind(payload(), dest({ dir: '/root', deviceId: 'dev2' }), false)).toBe(
      'copy'
    );
  });

  test('a directory cannot go into its own descendant', () => {
    const data = payload({
      paths: ['/root/a.txt', '/root/src'],
      names: ['a.txt', 'src'],
      hasDirectory: true,
    });
    expect(resolveDropKind(data, dest({ dir: '/root/src/deep/er' }), false)).toBe('none');
    expect(resolveDropKind(data, dest({ dir: '/root/src/deep' }), true)).toBe('none');
    // 前缀相同但不是子孙
    expect(resolveDropKind(data, dest({ dir: '/root/src2' }), false)).toBe('move');
    // 另一 root 下的同名路径不受限
    expect(resolveDropKind(data, dest({ dir: '/root/src/deep', rootId: 'r2' }), false)).toBe(
      'move'
    );
  });

  test('the descendant rule only applies when a directory is dragged', () => {
    expect(resolveDropKind(payload(), dest({ dir: '/root/a.txt/x' }), false)).toBe('move');
  });
});
