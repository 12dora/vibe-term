import { describe, expect, test } from 'bun:test';
import type { DeviceFolder, DeviceFolderItemRef, DeviceFolderLayout } from '@tmex/shared';
import { deviceFolderItemKey } from '@tmex/shared';
import {
  ROOT_CONTAINER_ID,
  applyDrop,
  bodyDropZoneId,
  containerChildIds,
  containerFolderId,
  dropZoneId,
  folderContainerId,
  folderElementId,
  implicitRootItems,
  listContainers,
  materializeRootItems,
  parseDropZoneId,
  parseFolderElementId,
  placedDeviceIds,
  resolveDrop,
} from './folder-tree-model';

function folder(id: string, parentId: string | null, sortOrder: number): DeviceFolder {
  return {
    id,
    name: id,
    parentId,
    sortOrder,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
}

function nodeItem(nodeId: string): DeviceFolderItemRef {
  return { kind: 'node', nodeId, deviceId: null };
}

function deviceItem(nodeId: string, deviceId: string): DeviceFolderItemRef {
  return { kind: 'device', nodeId, deviceId };
}

function placement(item: DeviceFolderItemRef, folderId: string | null, sortOrder: number) {
  return { ...item, folderId, sortOrder };
}

/** a（含子 a1）与 b 两个根文件夹；a 里放着 self 的 d1，根层显式放着 node n1 */
function sampleLayout(): DeviceFolderLayout {
  return {
    folders: [folder('a', null, 0), folder('b', null, 1), folder('a1', 'a', 0)],
    placements: [placement(deviceItem('self', 'd1'), 'a', 0), placement(nodeItem('n1'), null, 0)],
  };
}

describe('id 编解码', () => {
  test('文件夹元素 / 容器 / 放置区 id 可逆', () => {
    expect(folderElementId('a')).toBe('folder:a');
    expect(parseFolderElementId('folder:a')).toBe('a');
    expect(parseFolderElementId('node:self')).toBeNull();
    expect(parseFolderElementId('folder:')).toBeNull();

    expect(folderContainerId(null)).toBe(ROOT_CONTAINER_ID);
    expect(folderContainerId('a')).toBe('folder:a');
    expect(containerFolderId(ROOT_CONTAINER_ID)).toBeNull();
    expect(containerFolderId('folder:a')).toBe('a');
    expect(containerFolderId('nope')).toBeUndefined();

    expect(dropZoneId(folderContainerId('a'))).toBe('drop:folder:a');
    expect(parseDropZoneId('drop:folder:a')).toBe('folder:a');
    expect(parseDropZoneId('drop:root')).toBe('root');
    expect(parseDropZoneId('folder:a')).toBeNull();
    // 空文件夹内容区是同一容器的第二个放置区，id 不同但解析到同一个容器
    expect(bodyDropZoneId(folderContainerId('a'))).toBe('dropin:folder:a');
    expect(parseDropZoneId(bodyDropZoneId(folderContainerId('a')))).toBe('folder:a');
  });
});

describe('listContainers', () => {
  test('每个容器按 sortOrder 排序，文件夹在前、条目在后', () => {
    const containers = listContainers(sampleLayout(), [nodeItem('self'), nodeItem('n2')]);

    const root = containers.get(ROOT_CONTAINER_ID);
    expect(root).toBeDefined();
    expect(containerChildIds(root as NonNullable<typeof root>)).toEqual([
      'folder:a',
      'folder:b',
      'node:n1',
      'node:self',
      'node:n2',
    ]);

    const a = containers.get('folder:a');
    expect(containerChildIds(a as NonNullable<typeof a>)).toEqual(['folder:a1', 'device:self:d1']);
    expect(containers.get('folder:a1')?.itemKeys).toEqual([]);
  });

  test('隐式根条目排在显式 placement 之后，已放置的不再是隐式', () => {
    const layout = sampleLayout();
    expect(implicitRootItems(layout, [nodeItem('n1'), nodeItem('self')])).toEqual([
      nodeItem('self'),
    ]);
  });

  test('指向不存在文件夹的孤儿元素被忽略', () => {
    const layout: DeviceFolderLayout = {
      folders: [folder('a', 'ghost', 0)],
      placements: [placement(nodeItem('n1'), 'ghost', 0)],
    };
    const containers = listContainers(layout);
    expect(containers.get(ROOT_CONTAINER_ID)?.folderIds).toEqual([]);
    expect(containers.get(ROOT_CONTAINER_ID)?.itemKeys).toEqual([]);
    // 文件夹自身仍是一个容器（可以往里放东西）
    expect(containers.has('folder:a')).toBe(true);
  });
});

describe('resolveDrop', () => {
  const implicit = [nodeItem('self')];

  test('空文件夹内容区与文件夹头是同一个落点', () => {
    expect(
      resolveDrop('node:self', bodyDropZoneId(folderContainerId('a1')), sampleLayout(), implicit)
    ).toEqual({ kind: 'item', item: nodeItem('self'), targetFolderId: 'a1', index: null });
  });

  test('落在放置区上：追加到该容器末尾', () => {
    expect(resolveDrop('node:self', dropZoneId('folder:b'), sampleLayout(), implicit)).toEqual({
      kind: 'item',
      item: nodeItem('self'),
      targetFolderId: 'b',
      index: null,
    });
    expect(resolveDrop('folder:b', dropZoneId('folder:a'), sampleLayout(), implicit)).toEqual({
      kind: 'folder',
      folderId: 'b',
      targetFolderId: 'a',
      index: null,
    });
  });

  test('落在兄弟条目上：插到该条目所在容器的这个位置', () => {
    expect(resolveDrop('node:self', 'device:self:d1', sampleLayout(), implicit)).toEqual({
      kind: 'item',
      item: nodeItem('self'),
      targetFolderId: 'a',
      index: 0,
    });
  });

  test('条目落在文件夹行上 = 放进这个文件夹', () => {
    expect(resolveDrop('node:self', 'folder:a1', sampleLayout(), implicit)).toEqual({
      kind: 'item',
      item: nodeItem('self'),
      targetFolderId: 'a1',
      index: null,
    });
  });

  test('文件夹落在文件夹上：插到目标所在容器的这个位置', () => {
    expect(resolveDrop('folder:b', 'folder:a1', sampleLayout(), implicit)).toEqual({
      kind: 'folder',
      folderId: 'b',
      targetFolderId: 'a',
      index: 0,
    });
  });

  test('文件夹落在条目上：追加到该容器的文件夹末尾', () => {
    expect(resolveDrop('folder:b', 'device:self:d1', sampleLayout(), implicit)).toEqual({
      kind: 'folder',
      folderId: 'b',
      targetFolderId: 'a',
      index: null,
    });
  });

  test('拖到自己 / 自己的后代内一律拒绝', () => {
    expect(resolveDrop('folder:a', 'folder:a', sampleLayout(), implicit)).toBeNull();
    expect(resolveDrop('folder:a', dropZoneId('folder:a'), sampleLayout(), implicit)).toBeNull();
    expect(resolveDrop('folder:a', dropZoneId('folder:a1'), sampleLayout(), implicit)).toBeNull();
    expect(resolveDrop('folder:a', 'folder:a1', sampleLayout(), implicit)).toBeNull();
  });

  test('不认识的 id 一律返回 null', () => {
    expect(resolveDrop('bogus', 'drop:root', sampleLayout(), implicit)).toBeNull();
    expect(resolveDrop('node:self', 'bogus', sampleLayout(), implicit)).toBeNull();
    expect(resolveDrop('node:self', 'drop:nope', sampleLayout(), implicit)).toBeNull();
    expect(resolveDrop('node:self', 'drop:folder:ghost', sampleLayout(), implicit)).toBeNull();
  });
});

describe('applyDrop', () => {
  test('条目移入文件夹后从根层消失', () => {
    const layout = sampleLayout();
    const drop = resolveDrop('node:n1', dropZoneId('folder:b'), layout, []);
    const next = applyDrop(layout, drop as NonNullable<typeof drop>, []);
    expect(next).not.toBeNull();
    const containers = listContainers(next as DeviceFolderLayout, []);
    expect(containers.get(ROOT_CONTAINER_ID)?.itemKeys).toEqual([]);
    expect(containers.get('folder:b')?.itemKeys).toEqual(['node:n1']);
  });

  test('根层排序会把隐式条目显式化，顺序按拖拽结果落定', () => {
    const layout: DeviceFolderLayout = { folders: [], placements: [] };
    const implicit = [nodeItem('self'), nodeItem('n1'), nodeItem('n2')];
    const drop = resolveDrop('node:n2', 'node:self', layout, implicit);
    const next = applyDrop(layout, drop as NonNullable<typeof drop>, implicit);
    expect(listContainers(next as DeviceFolderLayout, []).get(ROOT_CONTAINER_ID)?.itemKeys).toEqual(
      ['node:n2', 'node:self', 'node:n1']
    );
  });

  test('同容器内向下移动落在目标之后', () => {
    const layout: DeviceFolderLayout = {
      folders: [],
      placements: [
        placement(nodeItem('a'), null, 0),
        placement(nodeItem('b'), null, 1),
        placement(nodeItem('c'), null, 2),
      ],
    };
    const drop = resolveDrop('node:a', 'node:c', layout, []);
    const next = applyDrop(layout, drop as NonNullable<typeof drop>, []);
    expect(listContainers(next as DeviceFolderLayout, []).get(ROOT_CONTAINER_ID)?.itemKeys).toEqual(
      ['node:b', 'node:c', 'node:a']
    );
  });

  test('文件夹移动到根层末尾', () => {
    const layout = sampleLayout();
    const drop = resolveDrop('folder:a1', dropZoneId(ROOT_CONTAINER_ID), layout, []);
    const next = applyDrop(layout, drop as NonNullable<typeof drop>, []);
    expect(
      listContainers(next as DeviceFolderLayout, []).get(ROOT_CONTAINER_ID)?.folderIds
    ).toEqual(['folder:a', 'folder:b', 'folder:a1']);
  });

  test('目标文件夹不存在时返回 null，不产生半截布局', () => {
    expect(
      applyDrop(sampleLayout(), {
        kind: 'item',
        item: nodeItem('n1'),
        targetFolderId: 'ghost',
        index: null,
      })
    ).toBeNull();
  });
});

describe('materializeRootItems / placedDeviceIds', () => {
  test('隐式条目落成显式 placement 时接在现有根层之后', () => {
    const layout = sampleLayout();
    const next = materializeRootItems(layout, [nodeItem('self'), nodeItem('n1')]);
    const rootKeys = next.placements
      .filter((item) => item.folderId === null)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(deviceFolderItemKey);
    expect(rootKeys).toEqual(['node:n1', 'node:self']);
  });

  test('没有隐式条目时原样返回', () => {
    const layout = sampleLayout();
    expect(materializeRootItems(layout, [])).toBe(layout);
  });

  test('只统计该 node 上被单独放置的设备', () => {
    const layout: DeviceFolderLayout = {
      folders: [folder('a', null, 0)],
      placements: [
        placement(deviceItem('self', 'd1'), 'a', 0),
        placement(deviceItem('n1', 'd2'), 'a', 1),
        placement(nodeItem('n2'), 'a', 2),
      ],
    };
    expect([...placedDeviceIds(layout, 'self')]).toEqual(['d1']);
    expect([...placedDeviceIds(layout, 'n1')]).toEqual(['d2']);
    expect([...placedDeviceIds(layout, 'n2')]).toEqual([]);
  });
});
