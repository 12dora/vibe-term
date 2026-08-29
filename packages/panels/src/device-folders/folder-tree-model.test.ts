import { describe, expect, test } from 'bun:test';
import type { DeviceFolder, DeviceFolderLayout } from '@tmex/shared';
import {
  ROOT_CONTAINER_ID,
  applyDrop,
  bodyDropZoneId,
  collisionCandidateIds,
  containerFolderId,
  dropTargetContainerId,
  dropZoneId,
  folderContainerId,
  folderElementId,
  implicitRootNodeIds,
  listContainers,
  materializeRootNodes,
  nodeElementId,
  parseDropZoneId,
  parseFolderElementId,
  parseNodeElementId,
  resolveDrop,
  rootFolderElementIds,
} from './folder-tree-model';

function folder(id: string, sortOrder: number): DeviceFolder {
  return {
    id,
    name: id,
    sortOrder,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
}

function placement(nodeId: string, folderId: string | null, sortOrder: number) {
  return { nodeId, folderId, sortOrder };
}

/** a 与 b 两个分组；a 里放着 n1，根层显式放着 n2 */
function sampleLayout(): DeviceFolderLayout {
  return {
    folders: [folder('a', 0), folder('b', 1)],
    placements: [placement('n1', 'a', 0), placement('n2', null, 0)],
  };
}

describe('id 编解码', () => {
  test('分组 / 节点 / 容器 / 放置区 id 可逆', () => {
    expect(folderElementId('a')).toBe('folder:a');
    expect(parseFolderElementId('folder:a')).toBe('a');
    expect(parseFolderElementId('node:self')).toBeNull();
    expect(parseFolderElementId('folder:')).toBeNull();
    expect(nodeElementId('self')).toBe('node:self');
    expect(parseNodeElementId('node:self')).toBe('self');
    expect(parseNodeElementId('folder:a')).toBeNull();

    expect(folderContainerId(null)).toBe(ROOT_CONTAINER_ID);
    expect(folderContainerId('a')).toBe('folder:a');
    expect(containerFolderId(ROOT_CONTAINER_ID)).toBeNull();
    expect(containerFolderId('folder:a')).toBe('a');
    expect(containerFolderId('nope')).toBeUndefined();

    expect(dropZoneId(folderContainerId('a'))).toBe('drop:folder:a');
    expect(parseDropZoneId('drop:folder:a')).toBe('folder:a');
    expect(parseDropZoneId('drop:root')).toBe('root');
    expect(parseDropZoneId('folder:a')).toBeNull();
    expect(bodyDropZoneId(folderContainerId('a'))).toBe('dropin:folder:a');
    expect(parseDropZoneId(bodyDropZoneId(folderContainerId('a')))).toBe('folder:a');
  });
});

describe('listContainers', () => {
  test('每个容器按 sortOrder 排序，根层显式在前、隐式在后', () => {
    const containers = listContainers(sampleLayout(), ['self', 'n3']);
    expect(containers.get(ROOT_CONTAINER_ID)?.nodeIds).toEqual(['node:n2', 'node:self', 'node:n3']);
    expect(containers.get('folder:a')?.nodeIds).toEqual(['node:n1']);
    expect(containers.get('folder:b')?.nodeIds).toEqual([]);
    expect(rootFolderElementIds(sampleLayout())).toEqual(['folder:a', 'folder:b']);
  });

  test('已放置的节点不再是隐式', () => {
    expect(implicitRootNodeIds(sampleLayout(), ['n1', 'self'])).toEqual(['self']);
  });

  test('指向不存在分组的孤儿 placement 被忽略', () => {
    const containers = listContainers({
      folders: [],
      placements: [placement('n1', 'ghost', 0)],
    });
    expect(containers.get(ROOT_CONTAINER_ID)?.nodeIds).toEqual([]);
  });
});

describe('resolveDrop：节点', () => {
  const implicit = ['self'];

  test('空分组内容区与分组头是同一个落点', () => {
    expect(resolveDrop('node:self', bodyDropZoneId('folder:b'), sampleLayout(), implicit)).toEqual({
      kind: 'node',
      nodeId: 'self',
      targetFolderId: 'b',
      index: null,
    });
    expect(resolveDrop('node:self', 'folder:b', sampleLayout(), implicit)).toEqual({
      kind: 'node',
      nodeId: 'self',
      targetFolderId: 'b',
      index: null,
    });
  });

  test('落在放置区上：追加到该容器末尾；根层落点条 = 移到最外层', () => {
    expect(resolveDrop('node:self', dropZoneId('folder:a'), sampleLayout(), implicit)).toEqual({
      kind: 'node',
      nodeId: 'self',
      targetFolderId: 'a',
      index: null,
    });
    expect(resolveDrop('node:n1', dropZoneId(ROOT_CONTAINER_ID), sampleLayout(), implicit)).toEqual(
      { kind: 'node', nodeId: 'n1', targetFolderId: null, index: null }
    );
  });

  test('落在兄弟节点上：插到该节点所在容器的这个位置', () => {
    expect(resolveDrop('node:self', 'node:n1', sampleLayout(), implicit)).toEqual({
      kind: 'node',
      nodeId: 'self',
      targetFolderId: 'a',
      index: 0,
    });
    expect(resolveDrop('node:n1', 'node:self', sampleLayout(), implicit)).toEqual({
      kind: 'node',
      nodeId: 'n1',
      targetFolderId: null,
      index: 1,
    });
  });

  test('不认识的 id 一律返回 null', () => {
    expect(resolveDrop('bogus', 'drop:root', sampleLayout(), implicit)).toBeNull();
    expect(resolveDrop('node:self', 'bogus', sampleLayout(), implicit)).toBeNull();
    expect(resolveDrop('node:self', 'drop:nope', sampleLayout(), implicit)).toBeNull();
    expect(resolveDrop('node:self', 'drop:folder:ghost', sampleLayout(), implicit)).toBeNull();
    expect(resolveDrop('node:self', 'node:self', sampleLayout(), implicit)).toBeNull();
  });
});

describe('resolveDrop：分组', () => {
  test('分组只能在根层重排：落在别的分组头上插到它的位置', () => {
    expect(resolveDrop('folder:b', 'folder:a', sampleLayout())).toEqual({
      kind: 'folder',
      folderId: 'b',
      index: 0,
    });
    expect(resolveDrop('folder:a', dropZoneId(ROOT_CONTAINER_ID), sampleLayout())).toEqual({
      kind: 'folder',
      folderId: 'a',
      index: null,
    });
  });

  test('分组落在别的分组头放置区上 = 插到那个分组的位置（与落在分组元素上同义）', () => {
    expect(resolveDrop('folder:b', dropZoneId('folder:a'), sampleLayout())).toEqual({
      kind: 'folder',
      folderId: 'b',
      index: 0,
    });
    expect(resolveDrop('folder:a', dropZoneId('folder:b'), sampleLayout())).toEqual({
      kind: 'folder',
      folderId: 'a',
      index: 1,
    });
  });

  test('分组落在节点 / 分组内容区 / 自己头上一律无效（不能嵌套）', () => {
    expect(resolveDrop('folder:b', 'node:n1', sampleLayout())).toBeNull();
    expect(resolveDrop('folder:b', 'node:n2', sampleLayout())).toBeNull();
    expect(resolveDrop('folder:b', bodyDropZoneId('folder:a'), sampleLayout())).toBeNull();
    expect(resolveDrop('folder:a', dropZoneId('folder:a'), sampleLayout())).toBeNull();
    expect(resolveDrop('folder:a', 'folder:a', sampleLayout())).toBeNull();
    expect(resolveDrop('folder:ghost', 'folder:a', sampleLayout())).toBeNull();
  });

  test('碰撞候选按拖动对象过滤（键盘排序也只会停在这些 id 上）', () => {
    const ids = [
      'folder:a',
      'folder:b',
      'node:n1',
      'node:n2',
      'node:self',
      dropZoneId('folder:a'),
      dropZoneId('folder:b'),
      bodyDropZoneId('folder:b'),
      dropZoneId(ROOT_CONTAINER_ID),
    ];
    expect(collisionCandidateIds('folder:b', ids)).toEqual([
      'folder:a',
      dropZoneId('folder:a'),
      dropZoneId('folder:b'),
      dropZoneId(ROOT_CONTAINER_ID),
    ]);
    expect(collisionCandidateIds('node:n1', ids)).toEqual([
      'node:n2',
      'node:self',
      dropZoneId('folder:a'),
      dropZoneId('folder:b'),
      bodyDropZoneId('folder:b'),
      dropZoneId(ROOT_CONTAINER_ID),
    ]);
    // 候选里的每个 id 对分组拖动都能解析成合法落点或被 resolveDrop 明确拒绝，不会落到节点上
    for (const id of collisionCandidateIds('folder:b', ids)) {
      const drop = resolveDrop('folder:b', id, sampleLayout());
      expect(drop === null || drop.kind === 'folder').toBe(true);
    }
    expect(collisionCandidateIds('bogus', ids)).toEqual([]);
  });

  test('dropTargetContainerId：分组重排高亮根层，节点高亮目标容器', () => {
    expect(dropTargetContainerId(null)).toBeNull();
    expect(dropTargetContainerId({ kind: 'folder', folderId: 'a', index: 0 })).toBe(
      ROOT_CONTAINER_ID
    );
    expect(
      dropTargetContainerId({ kind: 'node', nodeId: 'n1', targetFolderId: 'b', index: null })
    ).toBe('folder:b');
  });
});

describe('applyDrop', () => {
  test('节点移入分组后从根层消失', () => {
    const layout = sampleLayout();
    const drop = resolveDrop('node:n2', dropZoneId('folder:b'), layout, []);
    const next = applyDrop(layout, drop as NonNullable<typeof drop>, []);
    const containers = listContainers(next as DeviceFolderLayout, []);
    expect(containers.get(ROOT_CONTAINER_ID)?.nodeIds).toEqual([]);
    expect(containers.get('folder:b')?.nodeIds).toEqual(['node:n2']);
  });

  test('根层排序会把隐式节点显式化，顺序按拖拽结果落定', () => {
    const layout: DeviceFolderLayout = { folders: [], placements: [] };
    const implicit = ['self', 'n1', 'n2'];
    const drop = resolveDrop('node:n2', 'node:self', layout, implicit);
    const next = applyDrop(layout, drop as NonNullable<typeof drop>, implicit);
    expect(listContainers(next as DeviceFolderLayout, []).get(ROOT_CONTAINER_ID)?.nodeIds).toEqual([
      'node:n2',
      'node:self',
      'node:n1',
    ]);
  });

  test('同容器内向下移动落在目标之后', () => {
    const layout: DeviceFolderLayout = {
      folders: [],
      placements: [placement('a', null, 0), placement('b', null, 1), placement('c', null, 2)],
    };
    const drop = resolveDrop('node:a', 'node:c', layout, []);
    const next = applyDrop(layout, drop as NonNullable<typeof drop>, []);
    expect(listContainers(next as DeviceFolderLayout, []).get(ROOT_CONTAINER_ID)?.nodeIds).toEqual([
      'node:b',
      'node:c',
      'node:a',
    ]);
  });

  test('分组重排', () => {
    const layout = sampleLayout();
    const drop = resolveDrop('folder:b', 'folder:a', layout, []);
    const next = applyDrop(layout, drop as NonNullable<typeof drop>, []);
    expect(rootFolderElementIds(next as DeviceFolderLayout)).toEqual(['folder:b', 'folder:a']);
  });

  test('目标分组不存在时返回 null，不产生半截布局', () => {
    expect(
      applyDrop(sampleLayout(), {
        kind: 'node',
        nodeId: 'n2',
        targetFolderId: 'ghost',
        index: null,
      })
    ).toBeNull();
  });
});

describe('materializeRootNodes', () => {
  test('隐式节点落成显式 placement 时接在现有根层之后', () => {
    const next = materializeRootNodes(sampleLayout(), ['self', 'n2']);
    const rootIds = next.placements
      .filter((item) => item.folderId === null)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((item) => item.nodeId);
    expect(rootIds).toEqual(['n2', 'self']);
  });

  test('没有隐式节点时原样返回', () => {
    const layout = sampleLayout();
    expect(materializeRootNodes(layout, [])).toBe(layout);
  });
});
