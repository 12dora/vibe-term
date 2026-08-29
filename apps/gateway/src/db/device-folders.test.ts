import { beforeAll, describe, expect, test } from 'bun:test';
import { DEVICE_FOLDER_SELF_NODE_ID } from '@tmex/shared';
import { getDb as getOrmDb } from './client';
import {
  createDeviceFolder,
  deleteDeviceFolder,
  getDeviceFolderById,
  getDeviceFolderLayout,
  removeDeviceFolderPlacementsForDevice,
  replaceDeviceFolderLayout,
  resetDeviceFolderLayout,
  updateDeviceFolder,
} from './device-folders';
import { runMigrations } from './migrate';
import { deviceFolderPlacements, deviceFolders } from './schema';

beforeAll(() => {
  runMigrations();
});

function currentFolderOrder() {
  return getDeviceFolderLayout().folders.map((folder) => ({
    id: folder.id,
    sortOrder: folder.sortOrder,
  }));
}

describe('device folder db helper', () => {
  test('createDeviceFolder sortOrder 递增，parent 恒为空', () => {
    resetDeviceFolderLayout();
    const a = createDeviceFolder({ id: 'df-create-a', name: 'A' });
    const b = createDeviceFolder({ id: 'df-create-b', name: 'B' });
    expect(b.sortOrder).toBe(a.sortOrder + 1);
    expect(getDeviceFolderById('df-create-a')?.name).toBe('A');
    expect('parentId' in a).toBe(false);
  });

  test('updateDeviceFolder 改名 / 改顺序', () => {
    resetDeviceFolderLayout();
    const folder = createDeviceFolder({ id: 'df-upd', name: 'U' });
    expect(updateDeviceFolder(folder.id, { name: 'Renamed' })?.name).toBe('Renamed');
    expect(updateDeviceFolder(folder.id, { sortOrder: 7 })?.sortOrder).toBe(7);
    expect(updateDeviceFolder('df-missing', { name: 'x' })).toBeNull();
  });

  test('deleteDeviceFolder 把其中的节点上提到根层，排在根层现有节点之后', () => {
    resetDeviceFolderLayout();
    const group = createDeviceFolder({ id: 'df-del', name: 'Del' });
    replaceDeviceFolderLayout({
      folders: currentFolderOrder(),
      placements: [
        { nodeId: 'root-node', folderId: null, sortOrder: 0 },
        { nodeId: 'mesh-n1', folderId: group.id, sortOrder: 0 },
        { nodeId: 'mesh-n2', folderId: group.id, sortOrder: 1 },
      ],
    });

    expect(deleteDeviceFolder(group.id)).toBe(true);
    expect(getDeviceFolderById(group.id)).toBeNull();
    const root = getDeviceFolderLayout()
      .placements.filter((placement) => placement.folderId === null)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((placement) => placement.nodeId);
    expect(root).toEqual(['root-node', 'mesh-n1', 'mesh-n2']);
    expect(deleteDeviceFolder('df-del-missing')).toBe(false);
  });

  test('replaceDeviceFolderLayout 整体替换 placement 并规范化顺序', () => {
    resetDeviceFolderLayout();
    const fa = createDeviceFolder({ id: 'df-rep-a', name: 'RA' });
    const fb = createDeviceFolder({ id: 'df-rep-b', name: 'RB' });
    const next = replaceDeviceFolderLayout({
      folders: [
        { id: fa.id, sortOrder: 99 },
        { id: fb.id, sortOrder: 1 },
      ],
      placements: [{ nodeId: 'rep-node', folderId: fa.id, sortOrder: 5 }],
    });
    expect(next.folders.map((folder) => folder.id)).toEqual([fb.id, fa.id]);
    expect(next.folders.map((folder) => folder.sortOrder)).toEqual([0, 1]);
    expect(next.placements).toEqual([{ nodeId: 'rep-node', folderId: fa.id, sortOrder: 0 }]);
  });

  test('replaceDeviceFolderLayout 拒绝 id 集合不一致与非法布局（绕过 HTTP 的最后防线）', () => {
    resetDeviceFolderLayout();
    const folder = createDeviceFolder({ id: 'df-guard', name: 'G' });
    expect(() => replaceDeviceFolderLayout({ folders: [], placements: [] })).toThrow();
    expect(() =>
      replaceDeviceFolderLayout({
        folders: [{ id: folder.id, sortOrder: 0 }],
        placements: [{ nodeId: 'n', folderId: 'ghost', sortOrder: 0 }],
      })
    ).toThrow();
    expect(() =>
      replaceDeviceFolderLayout({
        folders: [{ id: folder.id, sortOrder: 0 }],
        placements: [
          { nodeId: 'n', folderId: null, sortOrder: 0 },
          { nodeId: 'n', folderId: null, sortOrder: 1 },
        ],
      })
    ).toThrow();
    expect(getDeviceFolderLayout().folders.map((item) => item.id)).toEqual([folder.id]);
  });

  test('resetDeviceFolderLayout 一次清掉全部分组与 placement', () => {
    const folder = createDeviceFolder({ id: 'df-reset', name: 'R' });
    replaceDeviceFolderLayout({
      folders: currentFolderOrder(),
      placements: [{ nodeId: 'reset-node', folderId: folder.id, sortOrder: 0 }],
    });
    expect(resetDeviceFolderLayout()).toEqual({ folders: [], placements: [] });
    expect(getDeviceFolderLayout()).toEqual({ folders: [], placements: [] });
  });

  test('读取时忽略库里残留的嵌套分组与设备 placement', () => {
    resetDeviceFolderLayout();
    const now = new Date().toISOString();
    const orm = getOrmDb();
    orm
      .insert(deviceFolders)
      .values({
        id: 'df-legacy-root',
        name: 'Root',
        parentId: null,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    orm
      .insert(deviceFolders)
      .values({
        id: 'df-legacy-child',
        name: 'Child',
        parentId: 'df-legacy-root',
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    orm
      .insert(deviceFolderPlacements)
      .values({
        itemKey: 'device:self:legacy',
        kind: 'device',
        nodeId: DEVICE_FOLDER_SELF_NODE_ID,
        deviceId: 'legacy',
        folderId: 'df-legacy-root',
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const layout = getDeviceFolderLayout();
    expect(layout.folders.map((folder) => folder.id)).toEqual(['df-legacy-root']);
    expect(layout.placements).toEqual([]);
    expect(getDeviceFolderById('df-legacy-child')).toBeNull();

    removeDeviceFolderPlacementsForDevice('legacy');
    expect(
      orm
        .select()
        .from(deviceFolderPlacements)
        .all()
        .some((row) => row.deviceId === 'legacy')
    ).toBe(false);
    resetDeviceFolderLayout();
  });
});
