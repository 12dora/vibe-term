import { describe, expect, test } from 'bun:test';
import type { DeviceFolder, DeviceFolderLayout } from './contracts/device-folders';
import {
  countFolderItems,
  deviceFolderPlacementKey,
  findNodeFolderId,
  isDeviceFolderLayoutValid,
  isFolderListValid,
  moveFolderInLayout,
  moveNodeInLayout,
  normalizeFolderLayoutOrder,
  removeNodeFromLayout,
  reparentOnFolderDelete,
  validateDeviceFolderName,
} from './device-folders';

function folder(id: string, sortOrder = 0): DeviceFolder {
  return { id, name: id, sortOrder, createdAt: 't', updatedAt: 't' };
}

const LAYOUT: DeviceFolderLayout = {
  folders: [folder('ops', 0), folder('misc', 1)],
  placements: [
    { nodeId: 'a', folderId: 'ops', sortOrder: 0 },
    { nodeId: 'b', folderId: 'ops', sortOrder: 1 },
    { nodeId: 'c', folderId: null, sortOrder: 0 },
  ],
};

describe('validateDeviceFolderName', () => {
  test('trims, collapses whitespace and rejects empty / too long', () => {
    expect(validateDeviceFolderName('  运维   组 ')).toEqual({ ok: true, name: '运维 组' });
    expect(validateDeviceFolderName('   ')).toEqual({ ok: false, error: 'empty' });
    expect(validateDeviceFolderName('x'.repeat(65))).toEqual({ ok: false, error: 'tooLong' });
    expect(validateDeviceFolderName('中'.repeat(64)).ok).toBe(true);
  });
});

describe('placement keys', () => {
  test('keeps the legacy node:<id> primary key', () => {
    expect(deviceFolderPlacementKey('n1')).toBe('node:n1');
  });
});

describe('layout validation', () => {
  test('isFolderListValid rejects duplicate ids', () => {
    expect(isFolderListValid(LAYOUT.folders)).toBe(true);
    expect(isFolderListValid([folder('a'), folder('a')])).toBe(false);
  });

  test('isDeviceFolderLayoutValid rejects unknown folders, duplicate nodes and empty node ids', () => {
    expect(isDeviceFolderLayoutValid(LAYOUT)).toBe(true);
    expect(
      isDeviceFolderLayoutValid({
        folders: [],
        placements: [{ nodeId: 'a', folderId: 'ghost', sortOrder: 0 }],
      })
    ).toBe(false);
    expect(
      isDeviceFolderLayoutValid({
        folders: [],
        placements: [
          { nodeId: 'a', folderId: null, sortOrder: 0 },
          { nodeId: 'a', folderId: null, sortOrder: 1 },
        ],
      })
    ).toBe(false);
    expect(
      isDeviceFolderLayoutValid({
        folders: [],
        placements: [{ nodeId: '', folderId: null, sortOrder: 0 }],
      })
    ).toBe(false);
    expect(
      isDeviceFolderLayoutValid({
        folders: [],
        placements: [{ nodeId: 'a', folderId: null, sortOrder: 1.5 }],
      })
    ).toBe(false);
  });
});

describe('normalizeFolderLayoutOrder', () => {
  test('renumbers folders globally and placements per container', () => {
    const next = normalizeFolderLayoutOrder({
      folders: [folder('x', 7), folder('y', 3)],
      placements: [
        { nodeId: 'a', folderId: 'x', sortOrder: 9 },
        { nodeId: 'b', folderId: 'x', sortOrder: 4 },
        { nodeId: 'c', folderId: null, sortOrder: 5 },
      ],
    });
    expect(next.folders.map((item) => [item.id, item.sortOrder])).toEqual([
      ['y', 0],
      ['x', 1],
    ]);
    expect(next.placements).toEqual([
      { nodeId: 'b', folderId: 'x', sortOrder: 0 },
      { nodeId: 'a', folderId: 'x', sortOrder: 1 },
      { nodeId: 'c', folderId: null, sortOrder: 0 },
    ]);
  });
});

describe('moveFolderInLayout', () => {
  test('reorders and renumbers', () => {
    const next = moveFolderInLayout(LAYOUT, 'misc', 0);
    expect(next?.folders.map((item) => item.id)).toEqual(['misc', 'ops']);
    expect(next?.folders.map((item) => item.sortOrder)).toEqual([0, 1]);
  });

  test('unknown folder returns null', () => {
    expect(moveFolderInLayout(LAYOUT, 'nope', null)).toBeNull();
  });
});

describe('moveNodeInLayout', () => {
  test('moves an existing placement between containers at an index', () => {
    const next = moveNodeInLayout(LAYOUT, 'b', 'ops', 0);
    const ops = next?.placements
      .filter((placement) => placement.folderId === 'ops')
      .sort((x, y) => x.sortOrder - y.sortOrder);
    expect(ops?.map((placement) => placement.nodeId)).toEqual(['b', 'a']);
  });

  test('adds a placement for an implicitly-rooted node and removes it again', () => {
    const next = moveNodeInLayout(LAYOUT, 'new', 'misc', null);
    expect(findNodeFolderId(next as DeviceFolderLayout, 'new')).toBe('misc');
    const removed = removeNodeFromLayout(next as DeviceFolderLayout, 'new');
    expect(removed.placements).toHaveLength(LAYOUT.placements.length);
  });

  test('moves into root explicit order', () => {
    const next = moveNodeInLayout(LAYOUT, 'a', null, 0);
    const root = next?.placements
      .filter((placement) => placement.folderId === null)
      .sort((x, y) => x.sortOrder - y.sortOrder);
    expect(root?.map((placement) => placement.nodeId)).toEqual(['a', 'c']);
  });

  test('rejects unknown target folder and empty node id', () => {
    expect(moveNodeInLayout(LAYOUT, 'a', 'nope', null)).toBeNull();
    expect(moveNodeInLayout(LAYOUT, '', null, null)).toBeNull();
  });
});

describe('reparentOnFolderDelete', () => {
  test('nodes in the deleted folder go to the root after existing root nodes', () => {
    const next = reparentOnFolderDelete(LAYOUT, 'ops');
    expect(next.folders.map((item) => item.id)).toEqual(['misc']);
    const root = next.placements
      .filter((placement) => placement.folderId === null)
      .sort((x, y) => x.sortOrder - y.sortOrder);
    expect(root.map((placement) => placement.nodeId)).toEqual(['c', 'a', 'b']);
  });

  test('unknown folder is a no-op', () => {
    expect(reparentOnFolderDelete(LAYOUT, 'nope')).toBe(LAYOUT);
  });
});

describe('countFolderItems', () => {
  test('counts nodes per folder, zero for empty folders', () => {
    const counts = countFolderItems(LAYOUT);
    expect(counts.get('ops')).toBe(2);
    expect(counts.get('misc')).toBe(0);
  });
});
