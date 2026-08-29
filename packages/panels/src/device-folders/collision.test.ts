// 碰撞判定：用假的矩形喂真实的 `deviceFolderCollisionDetection`（内部就是 dnd-kit 的
// pointerWithin / closestCenter），再把命中的 id 交给 `resolveDrop`，断言「指针停在哪里 →
// 最终插到第几位」这条完整链路。重点是兄弟之间的空隙：以前空隙会掉到外层的容器矩形上。

import { describe, expect, test } from 'bun:test';
import type { CollisionDetection } from '@dnd-kit/core';
import type { DeviceFolder, DeviceFolderLayout } from '@tmex/shared';
import { deviceFolderCollisionDetection } from './collision';
import {
  ROOT_CONTAINER_ID,
  applyDrop,
  bodyDropZoneId,
  dropZoneId,
  folderContainerId,
  listContainers,
  resolveDrop,
} from './folder-tree-model';

type Args = Parameters<CollisionDetection>[0];

interface Zone {
  id: string;
  /** [top, bottom] */
  top: number;
  bottom: number;
  containerId?: string;
}

function rect(top: number, bottom: number) {
  return { top, bottom, height: bottom - top, left: 0, right: 300, width: 300 };
}

/**
 * 页面布局（竖直方向；左右都占满 0..300）：
 *   分组 a  0..250     头 0..30，里面 n1 40..90 / n2 110..160 / n3 180..230
 *   分组 b  270..340   头 270..300，空内容区 305..335（空分组才有）
 *   根层    r1 360..410 / r2 430..480
 *   整棵树  0..600
 */
const ZONES: Zone[] = [
  { id: dropZoneId(ROOT_CONTAINER_ID), top: 0, bottom: 600 },
  { id: 'folder:a', top: 0, bottom: 250, containerId: ROOT_CONTAINER_ID },
  { id: dropZoneId('folder:a'), top: 0, bottom: 30 },
  { id: 'node:n1', top: 40, bottom: 90, containerId: 'folder:a' },
  { id: 'node:n2', top: 110, bottom: 160, containerId: 'folder:a' },
  { id: 'node:n3', top: 180, bottom: 230, containerId: 'folder:a' },
  { id: 'folder:b', top: 270, bottom: 340, containerId: ROOT_CONTAINER_ID },
  { id: dropZoneId('folder:b'), top: 270, bottom: 300 },
  { id: bodyDropZoneId('folder:b'), top: 305, bottom: 335 },
  { id: 'node:r1', top: 360, bottom: 410, containerId: ROOT_CONTAINER_ID },
  { id: 'node:r2', top: 430, bottom: 480, containerId: ROOT_CONTAINER_ID },
];

function folder(id: string, sortOrder: number): DeviceFolder {
  return {
    id,
    name: id,
    sortOrder,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
}

const LAYOUT: DeviceFolderLayout = {
  folders: [folder('a', 0), folder('b', 1)],
  placements: [
    { nodeId: 'n1', folderId: 'a', sortOrder: 0 },
    { nodeId: 'n2', folderId: 'a', sortOrder: 1 },
    { nodeId: 'n3', folderId: 'a', sortOrder: 2 },
    { nodeId: 'r1', folderId: null, sortOrder: 0 },
    { nodeId: 'r2', folderId: null, sortOrder: 1 },
  ],
};

function containerIdOfActive(activeId: string): string {
  return ZONES.find((zone) => zone.id === activeId)?.containerId ?? ROOT_CONTAINER_ID;
}

/** 指针在 y（键盘拖拽传 null），被拖元素的碰撞矩形是吸在指针上的那张小卡片 */
function args(activeId: string, y: number | null, zones: Zone[] = ZONES): Args {
  const droppableRects = new Map(zones.map((zone) => [zone.id, rect(zone.top, zone.bottom)]));
  const droppableContainers = zones.map((zone) => ({
    id: zone.id,
    key: zone.id,
    disabled: false,
    node: { current: null },
    rect: { current: rect(zone.top, zone.bottom) },
    data: { current: zone.containerId ? { containerId: zone.containerId } : {} },
  }));
  const collisionRect = rect((y ?? 0) - 10, (y ?? 0) + 10);
  return {
    active: {
      id: activeId,
      data: { current: { containerId: containerIdOfActive(activeId) } },
      rect: { current: { initial: collisionRect, translated: collisionRect } },
    },
    collisionRect,
    droppableRects,
    droppableContainers,
    pointerCoordinates: y === null ? null : { x: 150, y },
  } as unknown as Args;
}

/** 碰撞判定选中的 id（没有命中返回 null） */
function overId(activeId: string, y: number | null, zones?: Zone[]): string | null {
  const hits = deviceFolderCollisionDetection(args(activeId, y, zones));
  return hits.length > 0 ? String(hits[0]?.id) : null;
}

function orderAfterDrop(activeId: string, y: number, containerId: string): string[] | undefined {
  const over = overId(activeId, y);
  expect(over).not.toBeNull();
  const drop = resolveDrop(activeId, String(over), LAYOUT);
  expect(drop).not.toBeNull();
  const next = applyDrop(LAYOUT, drop as NonNullable<typeof drop>);
  expect(next).not.toBeNull();
  return listContainers(next as DeviceFolderLayout).get(containerId)?.nodeIds;
}

describe('落点分档：条目之间的空隙归给相邻的兄弟', () => {
  test('同容器重排：停在 n2 与 n3 之间的空隙 → 落到 n2 上，真的换了位置', () => {
    // 165 落在 n2（160 结束）与 n3（180 开始）之间：谁的中心近就是谁
    expect(overId('node:n1', 165)).toBe('node:n2');
    expect(orderAfterDrop('node:n1', 165, folderContainerId('a'))).toEqual([
      'node:n2',
      'node:n1',
      'node:n3',
    ]);
  });

  test('跨容器：停在分组内的空隙 → 插到空隙处，而不是追加到分组末尾', () => {
    expect(overId('node:r1', 165)).toBe('node:n2');
    expect(orderAfterDrop('node:r1', 165, folderContainerId('a'))).toEqual([
      'node:n1',
      'node:r1',
      'node:n2',
      'node:n3',
    ]);
  });

  test('分组重排：停在两个分组之间的空隙 → 插到空隙处，而不是甩到末尾', () => {
    // 260 落在分组 a（250 结束）与分组 b（270 开始）之间
    expect(overId('folder:b', 260)).toBe('folder:a');
    const drop = resolveDrop('folder:b', 'folder:a', LAYOUT);
    expect(drop).toEqual({ kind: 'folder', folderId: 'b', index: 0 });
  });

  test('根层：停在两个根层节点之间的空隙 → 落到相邻节点上', () => {
    expect(overId('node:n1', 425)).toBe('node:r2');
    expect(orderAfterDrop('node:n1', 425, ROOT_CONTAINER_ID)).toEqual([
      'node:r1',
      'node:n1',
      'node:r2',
    ]);
  });
});

describe('落点分档：容器与放置区', () => {
  test('分组头最先判，不会被里面的条目抢走', () => {
    expect(overId('node:r1', 15)).toBe(dropZoneId('folder:a'));
    expect(overId('node:r1', 285)).toBe(dropZoneId('folder:b'));
  });

  test('空分组的内容区仍然是落点', () => {
    expect(overId('node:r1', 320)).toBe(bodyDropZoneId('folder:b'));
  });

  test('分组本体先于整棵树：停在分组里的空白算这个分组', () => {
    // 240：分组 a 里最后一个条目（230 结束）之下、分组边框（250）之内，
    // 分组里还有兄弟，所以落到最近的 n3 上
    expect(overId('node:r1', 240)).toBe('node:n3');
    // 分组里一个兄弟都没有时才退回分组本体
    const empty = ZONES.filter((zone) => !zone.id.startsWith('node:n'));
    expect(overId('node:r1', 240, empty)).toBe('folder:a');
  });

  test('根层空白：没有根层兄弟时退回整棵树的根落点区', () => {
    const noRootNodes = ZONES.filter((zone) => zone.id !== 'node:r1' && zone.id !== 'node:r2');
    expect(overId('node:n1', 500, noRootNodes)).toBe(dropZoneId(ROOT_CONTAINER_ID));
    expect(resolveDrop('node:n1', dropZoneId(ROOT_CONTAINER_ID), LAYOUT)).toEqual({
      kind: 'node',
      nodeId: 'n1',
      targetFolderId: null,
      index: null,
    });
  });

  test('指针在整棵树之外：没有落点（= 取消）', () => {
    expect(overId('node:n1', 700)).toBeNull();
  });
});

describe('键盘拖拽（没有指针坐标）', () => {
  test('分组里的节点：一路往下最终能落到根落点区，移出分组', () => {
    // 整棵树的矩形太大，只把树底部的窄带算成根落点区：碰撞矩形挪到树底才会命中
    expect(overId('node:n1', null)).not.toBe(dropZoneId(ROOT_CONTAINER_ID));
    const bottom = args('node:n1', null);
    const rects = new Map(bottom.droppableRects);
    const collisionRect = rect(570, 600);
    const hits = deviceFolderCollisionDetection({
      ...bottom,
      collisionRect,
      droppableRects: rects,
    });
    expect(String(hits[0]?.id)).toBe(dropZoneId(ROOT_CONTAINER_ID));
  });

  test('已经在根层的节点不会被根落点区吸住（那是一次原地移动）', () => {
    const base = args('node:r1', null);
    const hits = deviceFolderCollisionDetection({ ...base, collisionRect: rect(570, 600) });
    expect(String(hits[0]?.id)).not.toBe(dropZoneId(ROOT_CONTAINER_ID));
  });
});
