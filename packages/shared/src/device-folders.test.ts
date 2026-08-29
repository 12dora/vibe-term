import { describe, expect, test } from 'bun:test';
import type { DeviceFolder, DeviceFolderLayout } from './contracts/device-folders';
import {
  buildDeviceFolderTree,
  deviceFolderItemKey,
  findItemFolderId,
  isFolderForestValid,
  moveFolderInLayout,
  moveItemInLayout,
  parseDeviceFolderItemKey,
  removeItemFromLayout,
  reparentOnFolderDelete,
  validateDeviceFolderName,
  wouldCreateFolderCycle,
} from './device-folders';

function folder(id: string, parentId: string | null, sortOrder = 0): DeviceFolder {
  return { id, name: id, parentId, sortOrder, createdAt: 't', updatedAt: 't' };
}

// ops ─┬─ web ─── deep
//      └─ db
const LAYOUT: DeviceFolderLayout = {
  folders: [
    folder('ops', null, 0),
    folder('web', 'ops', 0),
    folder('db', 'ops', 1),
    folder('deep', 'web', 0),
    folder('misc', null, 1),
  ],
  placements: [
    { kind: 'node', nodeId: 'a', deviceId: null, folderId: 'ops', sortOrder: 0 },
    { kind: 'device', nodeId: 'self', deviceId: 'd1', folderId: 'web', sortOrder: 0 },
    { kind: 'device', nodeId: 'self', deviceId: 'd2', folderId: 'web', sortOrder: 1 },
    { kind: 'device', nodeId: 'b', deviceId: 'd3', folderId: null, sortOrder: 0 },
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

describe('item keys', () => {
  test('round-trips node and device refs', () => {
    const node = { kind: 'node' as const, nodeId: 'n1', deviceId: null };
    const device = { kind: 'device' as const, nodeId: 'self', deviceId: 'd-1' };
    expect(deviceFolderItemKey(node)).toBe('node:n1');
    expect(deviceFolderItemKey(device)).toBe('device:self:d-1');
    expect(parseDeviceFolderItemKey('node:n1')).toEqual(node);
    expect(parseDeviceFolderItemKey('device:self:d-1')).toEqual(device);
    expect(parseDeviceFolderItemKey('device:self')).toBeNull();
    expect(parseDeviceFolderItemKey('folder:x')).toBeNull();
  });
});

describe('cycle detection', () => {
  test('moving into own descendant or self is a cycle', () => {
    expect(wouldCreateFolderCycle(LAYOUT.folders, 'ops', 'deep')).toBe(true);
    expect(wouldCreateFolderCycle(LAYOUT.folders, 'ops', 'ops')).toBe(true);
    expect(wouldCreateFolderCycle(LAYOUT.folders, 'ops', 'misc')).toBe(false);
    expect(wouldCreateFolderCycle(LAYOUT.folders, 'deep', null)).toBe(false);
  });

  test('isFolderForestValid rejects cycles, dangling parents and duplicate ids', () => {
    expect(isFolderForestValid(LAYOUT.folders)).toBe(true);
    expect(isFolderForestValid([folder('a', 'b'), folder('b', 'a')])).toBe(false);
    expect(isFolderForestValid([folder('a', 'ghost')])).toBe(false);
    expect(isFolderForestValid([folder('a', null), folder('a', null)])).toBe(false);
  });
});

describe('moveFolderInLayout', () => {
  test('reparents and renumbers siblings', () => {
    const next = moveFolderInLayout(LAYOUT, 'db', null, 0);
    expect(next).not.toBeNull();
    const roots = next?.folders
      .filter((f) => f.parentId === null)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    expect(roots?.map((f) => f.id)).toEqual(['db', 'ops', 'misc']);
    expect(next?.folders.filter((f) => f.parentId === 'ops').map((f) => f.id)).toEqual(['web']);
  });

  test('returns null on cycle or unknown target', () => {
    expect(moveFolderInLayout(LAYOUT, 'ops', 'deep', null)).toBeNull();
    expect(moveFolderInLayout(LAYOUT, 'ops', 'nope', null)).toBeNull();
    expect(moveFolderInLayout(LAYOUT, 'nope', null, null)).toBeNull();
  });
});

describe('moveItemInLayout', () => {
  test('moves an existing placement between folders at an index', () => {
    const next = moveItemInLayout(
      LAYOUT,
      { kind: 'device', nodeId: 'self', deviceId: 'd2' },
      'web',
      0
    );
    const web = next?.placements
      .filter((p) => p.folderId === 'web')
      .sort((a, b) => a.sortOrder - b.sortOrder);
    expect(web?.map((p) => p.deviceId)).toEqual(['d2', 'd1']);
  });

  test('adds a placement for an implicitly-rooted item and removes it again', () => {
    const ref = { kind: 'device' as const, nodeId: 'self', deviceId: 'new' };
    const next = moveItemInLayout(LAYOUT, ref, 'db', null);
    expect(findItemFolderId(next as DeviceFolderLayout, ref)).toBe('db');
    const removed = removeItemFromLayout(next as DeviceFolderLayout, ref);
    expect(removed.placements).toHaveLength(LAYOUT.placements.length);
  });

  test('rejects unknown target folder', () => {
    expect(
      moveItemInLayout(LAYOUT, { kind: 'node', nodeId: 'a', deviceId: null }, 'nope', null)
    ).toBeNull();
  });
});

describe('reparentOnFolderDelete', () => {
  test('children folders and items go to the parent, appended after existing content', () => {
    const next = reparentOnFolderDelete(LAYOUT, 'web');
    expect(next.folders.map((f) => f.id)).not.toContain('web');
    const opsChildren = next.folders
      .filter((f) => f.parentId === 'ops')
      .sort((a, b) => a.sortOrder - b.sortOrder);
    expect(opsChildren.map((f) => f.id)).toEqual(['db', 'deep']);
    const opsItems = next.placements
      .filter((p) => p.folderId === 'ops')
      .sort((a, b) => a.sortOrder - b.sortOrder);
    expect(opsItems.map((p) => p.deviceId ?? p.nodeId)).toEqual(['a', 'd1', 'd2']);
  });

  test('deleting a root folder lifts content to root', () => {
    const next = reparentOnFolderDelete(LAYOUT, 'ops');
    expect(
      next.folders
        .filter((f) => f.parentId === null)
        .map((f) => f.id)
        .sort()
    ).toEqual(['db', 'misc', 'web']);
    expect(next.placements.find((p) => p.nodeId === 'a')?.folderId).toBeNull();
  });

  test('unknown folder is a no-op', () => {
    expect(reparentOnFolderDelete(LAYOUT, 'nope')).toBe(LAYOUT);
  });
});

describe('buildDeviceFolderTree', () => {
  test('nests folders, sorts by sortOrder and counts descendants', () => {
    const tree = buildDeviceFolderTree(LAYOUT);
    expect(tree.roots.map((n) => n.folder.id)).toEqual(['ops', 'misc']);
    const ops = tree.byId.get('ops');
    expect(ops?.children.map((n) => n.folder.id)).toEqual(['web', 'db']);
    expect(ops?.itemCount).toBe(3);
    expect(tree.byId.get('web')?.itemCount).toBe(2);
    expect(tree.rootItems.map((p) => p.deviceId)).toEqual(['d3']);
  });

  test('placements pointing at missing folders fall back to root', () => {
    const tree = buildDeviceFolderTree({
      folders: [],
      placements: [{ kind: 'node', nodeId: 'x', deviceId: null, folderId: 'gone', sortOrder: 0 }],
    });
    expect(tree.rootItems).toHaveLength(1);
  });
});
