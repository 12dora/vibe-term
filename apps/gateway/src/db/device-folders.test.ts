import { beforeAll, describe, expect, test } from 'bun:test';
import { DEVICE_FOLDER_SELF_NODE_ID, deviceFolderItemKey } from '@tmex/shared';
import {
  createDeviceFolder,
  deleteDeviceFolder,
  getDeviceFolderById,
  getDeviceFolderLayout,
  removeDeviceFolderPlacementsForDevice,
  replaceDeviceFolderLayout,
  updateDeviceFolder,
} from './device-folders';
import { runMigrations } from './migrate';

beforeAll(() => {
  runMigrations();
});

describe('device folder db helper', () => {
  test('createDeviceFolder 同父下 sortOrder 递增', () => {
    const a = createDeviceFolder({ id: 'df-create-a', name: 'A', parentId: null });
    const b = createDeviceFolder({ id: 'df-create-b', name: 'B', parentId: null });
    expect(b.sortOrder).toBe(a.sortOrder + 1);
    expect(getDeviceFolderById('df-create-a')?.name).toBe('A');
    const child = createDeviceFolder({
      id: 'df-create-child',
      name: 'Child',
      parentId: 'df-create-a',
    });
    expect(child.parentId).toBe('df-create-a');
    expect(child.sortOrder).toBe(0);
  });

  test('updateDeviceFolder 改名，改 parent 未给 sortOrder 时排到新父末尾', () => {
    const parent = createDeviceFolder({ id: 'df-upd-p', name: 'P', parentId: null });
    createDeviceFolder({ id: 'df-upd-sib', name: 'Sib', parentId: parent.id });
    const moved = createDeviceFolder({ id: 'df-upd-m', name: 'M', parentId: null });

    const renamed = updateDeviceFolder(moved.id, { name: 'Moved' });
    expect(renamed?.name).toBe('Moved');

    const reparented = updateDeviceFolder(moved.id, { parentId: parent.id });
    expect(reparented?.parentId).toBe(parent.id);
    expect(reparented?.sortOrder).toBe(1);
    expect(updateDeviceFolder('df-missing', { name: 'x' })).toBeNull();
  });

  test('deleteDeviceFolder 把子文件夹与 placement 上提到父级', () => {
    const root = createDeviceFolder({ id: 'df-del-root', name: 'Root', parentId: null });
    const mid = createDeviceFolder({
      id: 'df-del-mid',
      name: 'Mid',
      parentId: root.id,
    });
    const nested = createDeviceFolder({
      id: 'df-del-nested',
      name: 'Nested',
      parentId: mid.id,
    });
    replaceDeviceFolderLayout({
      folders: getDeviceFolderLayout().folders.map((folder) => ({
        id: folder.id,
        parentId: folder.parentId,
        sortOrder: folder.sortOrder,
      })),
      placements: [
        ...getDeviceFolderLayout().placements,
        {
          kind: 'device',
          nodeId: DEVICE_FOLDER_SELF_NODE_ID,
          deviceId: 'df-del-dev',
          folderId: mid.id,
          sortOrder: 0,
        },
        {
          kind: 'node',
          nodeId: 'mesh-n1',
          deviceId: null,
          folderId: mid.id,
          sortOrder: 1,
        },
      ],
    });

    expect(deleteDeviceFolder(mid.id)).toBe(true);
    expect(getDeviceFolderById(mid.id)).toBeNull();
    expect(getDeviceFolderById(nested.id)?.parentId).toBe(root.id);

    const layout = getDeviceFolderLayout();
    const placement = layout.placements.find(
      (item) => item.kind === 'device' && item.deviceId === 'df-del-dev'
    );
    expect(placement?.folderId).toBe(root.id);
    const nodePlacement = layout.placements.find((item) => item.nodeId === 'mesh-n1');
    expect(nodePlacement?.folderId).toBe(root.id);
    expect(deleteDeviceFolder('df-del-missing')).toBe(false);
  });

  test('replaceDeviceFolderLayout 整体替换 placement 并规范化顺序', () => {
    const fa = createDeviceFolder({ id: 'df-rep-a', name: 'RA', parentId: null });
    const fb = createDeviceFolder({ id: 'df-rep-b', name: 'RB', parentId: null });
    const current = getDeviceFolderLayout();
    const next = replaceDeviceFolderLayout({
      folders: current.folders.map((folder) =>
        folder.id === fb.id
          ? { id: fb.id, parentId: fa.id, sortOrder: 99 }
          : { id: folder.id, parentId: folder.parentId, sortOrder: folder.sortOrder }
      ),
      placements: [
        {
          kind: 'node',
          nodeId: 'rep-node',
          deviceId: null,
          folderId: fa.id,
          sortOrder: 5,
        },
      ],
    });
    expect(next.folders.find((folder) => folder.id === fb.id)?.parentId).toBe(fa.id);
    expect(next.folders.find((folder) => folder.id === fb.id)?.sortOrder).toBe(0);
    expect(next.placements).toEqual([
      {
        kind: 'node',
        nodeId: 'rep-node',
        deviceId: null,
        folderId: fa.id,
        sortOrder: 0,
      },
    ]);
  });

  test('removeDeviceFolderPlacementsForDevice 只删 self 节点上该设备的 placement', () => {
    const folder = createDeviceFolder({ id: 'df-rm-f', name: 'RF', parentId: null });
    replaceDeviceFolderLayout({
      folders: getDeviceFolderLayout().folders.map((item) => ({
        id: item.id,
        parentId: item.parentId,
        sortOrder: item.sortOrder,
      })),
      placements: [
        {
          kind: 'device',
          nodeId: DEVICE_FOLDER_SELF_NODE_ID,
          deviceId: 'dev-keep-other',
          folderId: folder.id,
          sortOrder: 0,
        },
        {
          kind: 'device',
          nodeId: DEVICE_FOLDER_SELF_NODE_ID,
          deviceId: 'dev-to-remove',
          folderId: folder.id,
          sortOrder: 1,
        },
        {
          kind: 'device',
          nodeId: 'mesh-other',
          deviceId: 'dev-to-remove',
          folderId: folder.id,
          sortOrder: 2,
        },
      ],
    });

    removeDeviceFolderPlacementsForDevice('dev-to-remove');
    const keys = getDeviceFolderLayout().placements.map((item) => deviceFolderItemKey(item));
    expect(keys).toContain(
      deviceFolderItemKey({
        kind: 'device',
        nodeId: DEVICE_FOLDER_SELF_NODE_ID,
        deviceId: 'dev-keep-other',
      })
    );
    expect(keys).toContain(
      deviceFolderItemKey({ kind: 'device', nodeId: 'mesh-other', deviceId: 'dev-to-remove' })
    );
    expect(keys).not.toContain(
      deviceFolderItemKey({
        kind: 'device',
        nodeId: DEVICE_FOLDER_SELF_NODE_ID,
        deviceId: 'dev-to-remove',
      })
    );
  });
});
