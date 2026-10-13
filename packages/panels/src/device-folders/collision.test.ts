// 碰撞判定：用假的矩形喂真实的 `deviceFolderCollisionDetection`（内部就是 dnd-kit 的
// pointerWithin / closestCenter），再把命中的 id 交给 `resolveDrop`，断言「指针停在哪里 →
// 最终插到第几位」这条完整链路。重点是兄弟之间的空隙：以前空隙会掉到外层的容器矩形上。
//
// 两套夹具：`ZONES` 是单列（每个条目占满整行，手机 / 窄容器的形态），`GRID` 是会换行的节点
// 磁贴网格（一行两三个、宽窄混排、行尾有空格、空分组）。

import { describe, expect, test } from 'bun:test';
import type { CollisionDetection } from '@dnd-kit/core';
import type { DeviceFolder, DeviceFolderLayout } from '@vibeterm/shared';
import {
  containingTile,
  createDeviceFolderCollisionDetection,
  deviceFolderCollisionDetection,
  insertionTile,
  keyboardLatchKey,
  nearestTile,
  reorderTargetId,
} from './collision';
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
  /** 缺省占满单列夹具的整行（0..300） */
  left?: number;
  right?: number;
  containerId?: string;
}

function rect(top: number, bottom: number, left = 0, right = 300) {
  return { top, bottom, height: bottom - top, left, right, width: right - left };
}

function zoneRect(zone: Zone) {
  return rect(zone.top, zone.bottom, zone.left, zone.right);
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

function containerIdOfActive(activeId: string, zones: Zone[]): string {
  return zones.find((zone) => zone.id === activeId)?.containerId ?? ROOT_CONTAINER_ID;
}

/**
 * 条目的 droppable data：所属容器 + sortable 挂上来的同容器数据顺序（节点与分组各排各的），
 * 与真实的 `useSortable` 一致。放置区没有 data。
 */
function dataOf(zone: Zone | undefined, zones: Zone[]) {
  if (!zone?.containerId) return {};
  const kind = zone.id.split(':')[0];
  const items = zones
    .filter((other) => other.containerId === zone.containerId && other.id.startsWith(`${kind}:`))
    .map((other) => other.id);
  return { containerId: zone.containerId, sortable: { items } };
}

/** 指针在 (x, y)（键盘拖拽 y 传 null），被拖元素的碰撞矩形是吸在指针上的那张小卡片 */
function args(activeId: string, y: number | null, zones: Zone[] = ZONES, x = 150): Args {
  const droppableRects = new Map(zones.map((zone) => [zone.id, zoneRect(zone)]));
  const droppableContainers = zones.map((zone) => ({
    id: zone.id,
    key: zone.id,
    disabled: false,
    node: { current: null },
    rect: { current: zoneRect(zone) },
    data: { current: dataOf(zone, zones) },
  }));
  const collisionRect = rect((y ?? 0) - 10, (y ?? 0) + 10, x - 40, x + 40);
  return {
    active: {
      id: activeId,
      data: {
        current: {
          containerId: containerIdOfActive(activeId, zones),
          ...dataOf(
            zones.find((zone) => zone.id === activeId),
            zones
          ),
        },
      },
      rect: { current: { initial: collisionRect, translated: collisionRect } },
    },
    collisionRect,
    droppableRects,
    droppableContainers,
    pointerCoordinates: y === null ? null : { x, y },
  } as unknown as Args;
}

/** 碰撞判定选中的 id（没有命中返回 null） */
function overId(activeId: string, y: number | null, zones?: Zone[], x?: number): string | null {
  const hits = deviceFolderCollisionDetection(args(activeId, y, zones, x));
  return hits.length > 0 ? String(hits[0]?.id) : null;
}

/** 把命中的 id 交给 `resolveDrop` + `applyDrop`，返回落下之后目标容器里的顺序 */
function orderAfter(
  layout: DeviceFolderLayout,
  activeId: string,
  over: string | null,
  containerId: string
): string[] | undefined {
  expect(over).not.toBeNull();
  const drop = resolveDrop(activeId, String(over), layout);
  expect(drop).not.toBeNull();
  const next = applyDrop(layout, drop as NonNullable<typeof drop>);
  expect(next).not.toBeNull();
  return listContainers(next as DeviceFolderLayout).get(containerId)?.nodeIds;
}

function orderAfterDrop(activeId: string, y: number, containerId: string): string[] | undefined {
  return orderAfter(LAYOUT, activeId, overId(activeId, y), containerId);
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

  test('跨容器：停在分组内的空隙 → 正好插进这条空隙，而不是追加到分组末尾', () => {
    // 落点是「插入位置」：n2 排在指针之前、n3 排在指针之后 → 插到 n3 前面
    expect(overId('node:r1', 165)).toBe('node:n3');
    expect(orderAfterDrop('node:r1', 165, folderContainerId('a'))).toEqual([
      'node:n1',
      'node:n2',
      'node:r1',
      'node:n3',
    ]);
  });

  test('跨容器：压在独占一行的条目上，上半区插到它前面、下半区插到它后面', () => {
    // n2 占 110..160，中线 135
    expect(overId('node:r1', 120)).toBe('node:n2');
    expect(overId('node:r1', 150)).toBe('node:n3');
  });

  test('分组重排：停在两个分组之间的空隙 → 插到空隙处，而不是甩到末尾', () => {
    // 260 落在分组 a（250 结束）与分组 b（270 开始）之间：离 b 自己的中心更近 = 还在原位
    expect(overId('folder:b', 260)).toBe('folder:b');
    // 越过中点就归给 a，不会掉到整棵树上被甩到末尾
    expect(overId('folder:b', 200)).toBe('folder:a');
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

describe('拖回原位：被拖元素自己也是候选', () => {
  test('n2 拖到 n3 再拖回自己原来的位置 → 选中自己，退避的兄弟归位', () => {
    expect(overId('node:n2', 205)).toBe('node:n3');
    expect(overId('node:n2', 135)).toBe('node:n2');
    expect(resolveDrop('node:n2', 'node:n2', LAYOUT)).toBeNull();
  });

  test('跨容器时原容器里的自己不会被别的容器当成兄弟', () => {
    // r1 占 360..410：上半区插到 r1 前面，下半区插到 r2 前面，都不会回头选中分组里的自己
    expect(overId('node:n2', 380)).toBe('node:r1');
    expect(overId('node:n2', 390)).toBe('node:r2');
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
    // 240：分组 a 里最后一个条目（230 结束）之下、分组边框（250）之内。
    // 从别的容器拖进来：所有兄弟都排在指针之前 → 落到分组本体上 = 追加到末尾
    expect(overId('node:r1', 240)).toBe('folder:a');
    expect(orderAfterDrop('node:r1', 240, folderContainerId('a'))).toEqual([
      'node:n1',
      'node:n2',
      'node:n3',
      'node:r1',
    ]);
    // 本来就在这个分组里：落到最近的 n3 上（落在分组本体上会被判成原地追加，整次白拖）
    expect(overId('node:n1', 240)).toBe('node:n3');
    // 分组里一个兄弟都没有时也是分组本体
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

/**
 * 节点磁贴网格（整棵树 0..900 × 0..700）：
 *   分组 g  0..330     头 0..30；三列（10..290 / 310..590 / 610..890）
 *     第 1 行 40..180   g1 占第 1 列，g2 跨第 2、3 列
 *     第 2 行 190..320  g3 占第 1 列，g4 占第 2 列，第 3 列空着
 *   分组 e  340..420   头 340..370，空内容区 375..415（整行宽）
 *   根层两列（0..440 / 460..900）
 *     第 1 行 440..540  q1、q2
 *     第 2 行 560..660  q3，第 2 列空着
 */
const GRID: Zone[] = [
  { id: dropZoneId(ROOT_CONTAINER_ID), top: 0, bottom: 700, left: 0, right: 900 },
  { id: 'folder:g', top: 0, bottom: 330, left: 0, right: 900, containerId: ROOT_CONTAINER_ID },
  { id: dropZoneId('folder:g'), top: 0, bottom: 30, left: 0, right: 900 },
  { id: 'node:g1', top: 40, bottom: 180, left: 10, right: 290, containerId: 'folder:g' },
  { id: 'node:g2', top: 40, bottom: 180, left: 310, right: 890, containerId: 'folder:g' },
  { id: 'node:g3', top: 190, bottom: 320, left: 10, right: 290, containerId: 'folder:g' },
  { id: 'node:g4', top: 190, bottom: 320, left: 310, right: 590, containerId: 'folder:g' },
  { id: 'folder:e', top: 340, bottom: 420, left: 0, right: 900, containerId: ROOT_CONTAINER_ID },
  { id: dropZoneId('folder:e'), top: 340, bottom: 370, left: 0, right: 900 },
  { id: bodyDropZoneId('folder:e'), top: 375, bottom: 415, left: 10, right: 890 },
  { id: 'node:q1', top: 440, bottom: 540, left: 0, right: 440, containerId: ROOT_CONTAINER_ID },
  { id: 'node:q2', top: 440, bottom: 540, left: 460, right: 900, containerId: ROOT_CONTAINER_ID },
  { id: 'node:q3', top: 560, bottom: 660, left: 0, right: 440, containerId: ROOT_CONTAINER_ID },
];

const GRID_LAYOUT: DeviceFolderLayout = {
  folders: [folder('g', 0), folder('e', 1)],
  placements: [
    { nodeId: 'g1', folderId: 'g', sortOrder: 0 },
    { nodeId: 'g2', folderId: 'g', sortOrder: 1 },
    { nodeId: 'g3', folderId: 'g', sortOrder: 2 },
    { nodeId: 'g4', folderId: 'g', sortOrder: 3 },
    { nodeId: 'q1', folderId: null, sortOrder: 0 },
    { nodeId: 'q2', folderId: null, sortOrder: 1 },
    { nodeId: 'q3', folderId: null, sortOrder: 2 },
  ],
};

function gridOver(activeId: string, x: number, y: number, zones: Zone[] = GRID): string | null {
  return overId(activeId, y, zones, x);
}

function gridOrder(activeId: string, x: number, y: number, containerId: string) {
  return orderAfter(GRID_LAYOUT, activeId, gridOver(activeId, x, y), containerId);
}

describe('网格 · 同容器重排（落点 = 插入位置，被拖节点自己不参与）', () => {
  const g = folderContainerId('g');

  test('压在宽磁贴的左半区 → 插到它前面；靠边也不会被隔壁窄磁贴的中心抢走', () => {
    // (320, 100) 在 g2 里紧贴左边：离 g1 的中心（150）比离 g2 的中心（600）近得多
    expect(gridOrder('node:g4', 320, 100, g)).toEqual(['node:g1', 'node:g4', 'node:g2', 'node:g3']);
    // g1 的右半区：同样是插在 g1 与 g2 之间
    expect(gridOrder('node:g4', 280, 100, g)).toEqual(['node:g1', 'node:g4', 'node:g2', 'node:g3']);
    // g1 的左半区：插到最前
    expect(gridOrder('node:g4', 100, 100, g)).toEqual(['node:g4', 'node:g1', 'node:g2', 'node:g3']);
  });

  test('同一行两个磁贴之间的空隙 → 插在两者之间', () => {
    // 第 2 行的空隙是 290..310；g1 拖进去 → g3 与 g4 之间
    for (const x of [296, 302]) {
      expect(gridOrder('node:g1', x, 250, g)).toEqual(['node:g2', 'node:g3', 'node:g1', 'node:g4']);
    }
  });

  test('行尾空格 → 挪到末尾，而不是被正上方的磁贴接走', () => {
    // (750, 250) 是第 2 行第 3 列的空格：正上方的 g2 更近，但那是另一行
    expect(gridOver('node:g1', 750, 250)).toBe('node:g4');
    expect(gridOrder('node:g1', 750, 250, g)).toEqual(['node:g2', 'node:g3', 'node:g4', 'node:g1']);
  });

  test('两行之间的空隙 → 插到下一行行首', () => {
    // 行间空隙 180..190；g4 拖上来 → g2 与 g3 之间
    for (const y of [183, 188]) {
      expect(gridOrder('node:g4', 150, y, g)).toEqual(['node:g1', 'node:g2', 'node:g4', 'node:g3']);
    }
  });

  test('落点换算出来就是它现在的位置 → 选中自己（原地不动）', () => {
    // g3 压在自己原来的格子上：排在它后面的第一个兄弟是 g4，「插到 g4 前面」正是它现在的位置
    expect(gridOver('node:g3', 150, 250)).toBe('node:g3');
    // g3 与 g4 之间的空隙对 g3 来说也是原位
    expect(gridOver('node:g3', 300, 250)).toBe('node:g3');
    // 最后一个拖到行尾空格：已经在末尾
    expect(gridOver('node:g4', 750, 250)).toBe('node:g4');
    expect(resolveDrop('node:g3', 'node:g3', GRID_LAYOUT)).toBeNull();
  });

  test('回流之后落点不变：被拖节点挪到哪儿都不影响判定（它自己不参与）', () => {
    // g4 拖到 g1 与 g2 之间后的真实排布：g4 占第 2 列，g2 换行跨两列，g3 排到第 3 行
    const reflowed = GRID.map((zone) => {
      if (zone.id === 'node:g4') return { ...zone, top: 40, bottom: 180, left: 310, right: 590 };
      if (zone.id === 'node:g2') return { ...zone, top: 190, bottom: 320, left: 10, right: 590 };
      if (zone.id === 'node:g3') return { ...zone, top: 330, bottom: 460, left: 10, right: 290 };
      if (zone.id === 'folder:g') return { ...zone, bottom: 470 };
      return zone;
    });
    // 指针还在原处 (320, 100)：现在压着的是被拖节点自己，落点仍然是「g2 前面」
    expect(gridOver('node:g4', 320, 100)).toBe('node:g2');
    expect(gridOver('node:g4', 320, 100, reflowed)).toBe('node:g2');
  });
});

describe('网格 · 跨容器插入（落点 = 插入位置）', () => {
  const g = folderContainerId('g');

  test('并排的磁贴按左右半区分前后', () => {
    // g1 占 10..290，中线 150
    expect(gridOrder('node:q1', 100, 100, g)).toEqual([
      'node:q1',
      'node:g1',
      'node:g2',
      'node:g3',
      'node:g4',
    ]);
    expect(gridOrder('node:q1', 200, 100, g)).toEqual([
      'node:g1',
      'node:q1',
      'node:g2',
      'node:g3',
      'node:g4',
    ]);
  });

  test('宽磁贴的右半区 → 插到下一行行首', () => {
    // g2 占 310..890，中线 600
    expect(gridOver('node:q1', 400, 100)).toBe('node:g2');
    expect(gridOver('node:q1', 700, 100)).toBe('node:g3');
    expect(gridOrder('node:q1', 700, 100, g)).toEqual([
      'node:g1',
      'node:g2',
      'node:q1',
      'node:g3',
      'node:g4',
    ]);
  });

  test('同一行的空隙 → 插在两者之间', () => {
    expect(gridOver('node:q1', 300, 250)).toBe('node:g4');
    expect(gridOrder('node:q1', 300, 250, g)).toEqual([
      'node:g1',
      'node:g2',
      'node:g3',
      'node:q1',
      'node:g4',
    ]);
  });

  test('两行之间的空隙 → 插到下一行行首', () => {
    expect(gridOver('node:q1', 700, 185)).toBe('node:g3');
  });

  test('行尾空格 / 最后一行之下 → 落到分组本体上，追加到末尾', () => {
    expect(gridOver('node:q1', 750, 250)).toBe('folder:g');
    expect(gridOver('node:q1', 450, 326)).toBe('folder:g');
    expect(gridOrder('node:q1', 750, 250, g)).toEqual([
      'node:g1',
      'node:g2',
      'node:g3',
      'node:g4',
      'node:q1',
    ]);
  });

  test('空分组：头与整行宽的内容区都接得住，哪一列都一样', () => {
    expect(gridOver('node:q1', 450, 355)).toBe(dropZoneId('folder:e'));
    expect(gridOver('node:q1', 80, 395)).toBe(bodyDropZoneId('folder:e'));
    expect(gridOver('node:q1', 820, 395)).toBe(bodyDropZoneId('folder:e'));
  });

  test('拖到根层：行内空隙插在两者之间，行尾空格追加到根层末尾', () => {
    // 根层第 1 行的空隙是 440..460
    expect(gridOrder('node:g1', 450, 490, ROOT_CONTAINER_ID)).toEqual([
      'node:q1',
      'node:g1',
      'node:q2',
      'node:q3',
    ]);
    // (700, 610) 是根层第 2 行第 2 列的空格
    expect(gridOver('node:g1', 700, 610)).toBe(dropZoneId(ROOT_CONTAINER_ID));
    expect(gridOrder('node:g1', 700, 610, ROOT_CONTAINER_ID)).toEqual([
      'node:q1',
      'node:q2',
      'node:q3',
      'node:g1',
    ]);
  });

  test('根层磁贴之上的空白（分组之间）→ 插到根层最前', () => {
    expect(gridOver('node:g1', 450, 430)).toBe('node:q1');
  });

  test('指针在整棵树之外：没有落点（= 取消）', () => {
    expect(gridOver('node:g1', 950, 250)).toBeNull();
    expect(gridOver('node:g1', 450, 720)).toBeNull();
  });
});

describe('挑选规则（纯函数）', () => {
  const tile = (id: string, top: number, bottom: number, left: number, right: number) => ({
    id,
    rect: rect(top, bottom, left, right),
  });
  const row = [tile('a', 0, 100, 0, 200), tile('b', 0, 100, 220, 420), tile('c', 120, 220, 0, 200)];

  test('nearestTile：没有条目返回 null；距离相同比中心', () => {
    expect(nearestTile({ x: 0, y: 0 }, [])).toBeNull();
    // (100, 110) 夹在 a 与 c 的正中（各差 10），离两者中心也一样远 → 先出现的那个
    expect(nearestTile({ x: 100, y: 110 }, row)?.id).toBe('a');
    expect(nearestTile({ x: 100, y: 112 }, row)?.id).toBe('c');
  });

  test('insertionTile：按阅读顺序取第一个排在指针之后的条目', () => {
    expect(insertionTile({ x: 50, y: 50 }, row, 420)?.id).toBe('a');
    expect(insertionTile({ x: 150, y: 50 }, row, 420)?.id).toBe('b');
    expect(insertionTile({ x: 400, y: 50 }, row, 420)?.id).toBe('c');
    expect(insertionTile({ x: 300, y: 170 }, row, 420)).toBeNull();
    // 条目乱序传进来结果不变：比的是几何位置，不是数组下标
    expect(insertionTile({ x: 400, y: 50 }, [...row].reverse(), 420)?.id).toBe('c');
  });

  test('insertionTile：量不到容器宽度时用条目铺开的宽度判断「独占一行」', () => {
    const column = [tile('a', 0, 100, 0, 300), tile('b', 120, 220, 0, 300)];
    // 独占一行 → 上下半区：a 的中线是 50
    expect(insertionTile({ x: 280, y: 20 }, column)?.id).toBe('a');
    expect(insertionTile({ x: 20, y: 80 }, column)?.id).toBe('b');
  });
});

/**
 * 键盘用的网格（都在根层，整棵树 0..900 × 0..330，三列 0..290 / 305..595 / 610..900）：
 *   第 1 行 0..100     k1 k2 k3
 *   第 2 行 115..215   kw 跨三列
 *   第 3 行 230..330   k4 k5 k6
 * 预览卡片是 160×40 的小卡片；每按一次方向键，`sortableKeyboardCoordinates` 把它的左上角对到
 * 目标条目的左上角。
 */
const KEYS: Zone[] = [
  { id: dropZoneId(ROOT_CONTAINER_ID), top: 0, bottom: 330, left: 0, right: 900 },
  { id: 'node:k1', top: 0, bottom: 100, left: 0, right: 290, containerId: ROOT_CONTAINER_ID },
  { id: 'node:k2', top: 0, bottom: 100, left: 305, right: 595, containerId: ROOT_CONTAINER_ID },
  { id: 'node:k3', top: 0, bottom: 100, left: 610, right: 900, containerId: ROOT_CONTAINER_ID },
  { id: 'node:kw', top: 115, bottom: 215, left: 0, right: 900, containerId: ROOT_CONTAINER_ID },
  { id: 'node:k4', top: 230, bottom: 330, left: 0, right: 290, containerId: ROOT_CONTAINER_ID },
  { id: 'node:k5', top: 230, bottom: 330, left: 305, right: 595, containerId: ROOT_CONTAINER_ID },
  { id: 'node:k6', top: 230, bottom: 330, left: 610, right: 900, containerId: ROOT_CONTAINER_ID },
];

/** 键盘拖拽：预览卡片的左上角在 (left, top) */
function keyboardArgs(activeId: string, left: number, top: number, zones: Zone[] = KEYS): Args {
  const collisionRect = rect(top, top + 40, left, left + 160);
  return { ...args(activeId, null, zones), collisionRect } as unknown as Args;
}

function keyboardOver(activeId: string, left: number, top: number, zones?: Zone[]): string | null {
  const hits = deviceFolderCollisionDetection(keyboardArgs(activeId, left, top, zones));
  return hits.length > 0 ? String(hits[0]?.id) : null;
}

describe('键盘拖拽 · 宽窄混排的网格', () => {
  test('ArrowDown：从窄磁贴下到整行宽的磁贴（它的中心离左上角有半个容器远）', () => {
    expect(keyboardOver('node:k1', 0, 115)).toBe('node:kw');
    expect(keyboardOver('node:k3', 0, 115)).toBe('node:kw');
    // 再往下：从宽磁贴到下一行
    expect(keyboardOver('node:kw', 0, 230)).toBe('node:k4');
  });

  test('ArrowUp：从窄磁贴上到整行宽的磁贴，再上到第一行', () => {
    expect(keyboardOver('node:k5', 0, 115)).toBe('node:kw');
    expect(keyboardOver('node:k6', 0, 115)).toBe('node:kw');
    expect(keyboardOver('node:kw', 0, 0)).toBe('node:k1');
  });

  test('ArrowRight / ArrowLeft：同一行里挪到相邻的磁贴', () => {
    expect(keyboardOver('node:k1', 305, 0)).toBe('node:k2');
    expect(keyboardOver('node:k2', 610, 0)).toBe('node:k3');
    expect(keyboardOver('node:k3', 305, 0)).toBe('node:k2');
    expect(keyboardOver('node:k5', 610, 230)).toBe('node:k6');
    expect(keyboardOver('node:k5', 0, 230)).toBe('node:k4');
  });

  test('还没动 / 挪回自己的格子 → 选中自己', () => {
    expect(keyboardOver('node:k2', 305, 0)).toBe('node:k2');
    expect(keyboardOver('node:kw', 0, 115)).toBe('node:kw');
  });

  test('贴边对齐差了不到一个像素也认', () => {
    expect(keyboardOver('node:k1', 304.4, -0.6)).toBe('node:k2');
    expect(keyboardOver('node:k1', -0.4, 114.5)).toBe('node:kw');
  });

  test('左上角不在任何条目里（停在空隙）→ 退回最近四角，仍有落点', () => {
    expect(keyboardOver('node:k1', 296, 104)).not.toBeNull();
  });
});

describe('键盘落点的锁', () => {
  // 跨容器时占位条会把目标兄弟挤走：kw 被挤到下一行，预览卡片底下换成了别人
  const shifted = KEYS.map((zone) => {
    if (zone.id === 'node:kw') return { ...zone, top: 230, bottom: 330 };
    if (zone.id === 'node:k4') return { ...zone, top: 115, bottom: 215 };
    return zone;
  });
  const over = (detect: ReturnType<typeof createDeviceFolderCollisionDetection>, input: Args) => {
    const hits = detect(input);
    return hits.length > 0 ? String(hits[0]?.id) : null;
  };

  test('预览卡片没动：沿用上一次的落点，回流不会让它自己跳走', () => {
    const detect = createDeviceFolderCollisionDetection();
    expect(over(detect, keyboardArgs('node:k1', 0, 115))).toBe('node:kw');
    // 无状态的判定照新的几何会改口
    expect(keyboardOver('node:k1', 0, 115, shifted)).toBe('node:k4');
    expect(over(detect, keyboardArgs('node:k1', 0, 115, shifted))).toBe('node:kw');
  });

  test('预览卡片挪了（按了方向键）就重新算', () => {
    const detect = createDeviceFolderCollisionDetection();
    expect(over(detect, keyboardArgs('node:k1', 0, 115))).toBe('node:kw');
    expect(over(detect, keyboardArgs('node:k1', 305, 0, shifted))).toBe('node:k2');
    expect(over(detect, keyboardArgs('node:k1', 0, 115, shifted))).toBe('node:k4');
  });

  test('锁住的落点已经不在了 / 换了被拖元素 / 改用指针 → 不沿用', () => {
    const detect = createDeviceFolderCollisionDetection();
    expect(over(detect, keyboardArgs('node:k1', 0, 115))).toBe('node:kw');
    const withoutWide = shifted.filter((zone) => zone.id !== 'node:kw');
    expect(over(detect, keyboardArgs('node:k1', 0, 115, withoutWide))).toBe('node:k4');

    expect(over(detect, keyboardArgs('node:k1', 0, 230))).toBe('node:k4');
    expect(over(detect, keyboardArgs('node:k2', 0, 230, shifted))).toBe('node:kw');

    // 指针拖拽不上锁，并且会把键盘留下的锁清掉
    expect(over(detect, args('node:k1', 50, KEYS, 850))).toBe('node:k3');
    expect(over(detect, keyboardArgs('node:k2', 0, 230))).toBe('node:k4');
  });

  test('锁的键按像素取整：亚像素抖动不算挪动', () => {
    expect(keyboardLatchKey('node:k1', { left: 304.6, top: 0.2 })).toBe('node:k1@305,0');
    expect(keyboardLatchKey('node:k1', { left: 305.3, top: -0.4 })).toBe(
      keyboardLatchKey('node:k1', { left: 304.6, top: 0.2 })
    );
    expect(keyboardLatchKey('node:k1', { left: 306, top: 0 })).not.toBe(
      keyboardLatchKey('node:k1', { left: 305, top: 0 })
    );
  });
});

describe('同容器换算与包含判定（纯函数）', () => {
  const order = ['a', 'b', 'c', 'd'];

  test('reorderTargetId：插入位置 → sortable 的「占谁的位置」', () => {
    // b 插到 d 前面：挪完在下标 2，那里原来是 c（往后挪 = 落在它前一个兄弟身上）
    expect(reorderTargetId(order, 'b', 'd')).toBe('c');
    // c 插到 a 前面：挪完在下标 0，那里原来是 a（往前挪 = 落在目标身上）
    expect(reorderTargetId(order, 'c', 'a')).toBe('a');
    // 末尾
    expect(reorderTargetId(order, 'a', null)).toBe('d');
  });

  test('reorderTargetId：换算出来是原位 → 返回它自己', () => {
    expect(reorderTargetId(order, 'b', 'c')).toBe('b');
    expect(reorderTargetId(order, 'd', null)).toBe('d');
    expect(reorderTargetId(['a'], 'a', null)).toBe('a');
    // 目标不在这个容器里：不动
    expect(reorderTargetId(order, 'b', 'zzz')).toBe('b');
  });

  test('containingTile：取包含该点的条目，重叠时取面积最小的', () => {
    const tile = (id: string, top: number, bottom: number, left: number, right: number) => ({
      id,
      rect: rect(top, bottom, left, right),
    });
    const tiles = [tile('outer', 0, 300, 0, 300), tile('inner', 0, 40, 0, 300)];
    expect(containingTile({ x: 10, y: 10 }, tiles)?.id).toBe('inner');
    expect(containingTile({ x: 10, y: 100 }, tiles)?.id).toBe('outer');
    expect(containingTile({ x: 10, y: 400 }, tiles)).toBeNull();
    // 边界算包含
    expect(containingTile({ x: 300, y: 300 }, tiles)?.id).toBe('outer');
  });
});
