// 指针拖拽 × 真实回流的稳定性：预览一变，网格就真的重排，落点矩形跟着变，判定被重跑。
// 这里用一个简化的 CSS grid 模型（稀疏的行内自动放置、同行等高、行高取最高的那块）把
// 「判定 → 预览顺序 → 新排布 → 再判定」这个回路跑起来，断言**指针不动时预览不会来回翻**。
//
// 模型与评审时的模拟脚本一致；被测的是真实的带状态判定（迟滞）+ 冻结的容器高度。无状态判定
// 在同样的场景下会振荡，作为对照留在用例里——它说明迟滞不是摆设。

import { describe, expect, test } from 'bun:test';
import type { CollisionDetection } from '@dnd-kit/core';
import type { DeviceFolderLayout } from '@vibeterm/shared';
import { createDeviceFolderCollisionDetection, deviceFolderCollisionDetection } from './collision';
import {
  ROOT_CONTAINER_ID,
  dropZoneId,
  listContainers,
  previewItemOrder,
  previewReorder,
  resolveDrop,
} from './folder-tree-model';

type Args = Parameters<CollisionDetection>[0];

interface Item {
  id: string;
  span: number;
  height: number;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const COLUMN = 406;
const GAP = 12;

function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/** 稀疏的行内自动放置（放不下就整块换行，不回填）、`align-items: stretch`、行高取最高的那块 */
function gridLayout(items: readonly Item[], columns: number) {
  const rows: { item: Item; column: number }[][] = [];
  let row: { item: Item; column: number }[] = [];
  let column = 0;
  for (const item of items) {
    const span = Math.min(item.span, columns);
    if (column + span > columns) {
      rows.push(row);
      row = [];
      column = 0;
    }
    row.push({ item, column });
    column += span;
  }
  if (row.length > 0) rows.push(row);
  const rects = new Map<string, Box>();
  let y = 0;
  for (const cells of rows) {
    const height = Math.max(...cells.map((cell) => cell.item.height));
    for (const cell of cells) {
      const span = Math.min(cell.item.span, columns);
      const width = span * COLUMN + (span - 1) * GAP;
      rects.set(cell.item.id, box(cell.column * (COLUMN + GAP), y, width, height));
    }
    y += height + GAP;
  }
  return { rects, height: y - GAP };
}

interface Scene {
  items: readonly Item[];
  columns: number;
  /** 被拖节点（`items` 里的 id，不带 `node:` 前缀） */
  active: string;
}

/**
 * 把一个场景接成可以一步步推进的回路。`step(point)` = 按当前预览顺序排一次网格、跑一次判定、
 * 把预览顺序更新成判定的结果，返回新的预览顺序（去掉 `node:` 前缀）。
 */
function simulate(scene: Scene, detect: CollisionDetection, frozen: boolean) {
  const { items, columns } = scene;
  const layout: DeviceFolderLayout = {
    folders: [],
    placements: items.map((item, sortOrder) => ({ nodeId: item.id, folderId: null, sortOrder })),
  };
  const containers = listContainers(layout, []);
  const dataOrder = containers.get(ROOT_CONTAINER_ID)?.nodeIds ?? [];
  const byId = new Map(items.map((item) => [`node:${item.id}`, item]));
  const activeId = `node:${scene.active}`;
  const rootZone = dropZoneId(ROOT_CONTAINER_ID);
  const width = columns * COLUMN + (columns - 1) * GAP;
  const data = { current: { containerId: ROOT_CONTAINER_ID, sortable: { items: dataOrder } } };
  const arrange = (order: readonly string[]) =>
    gridLayout(
      order.flatMap((id) => {
        const item = byId.get(id);
        return item ? [{ ...item, id }] : [];
      }),
      columns
    );
  const initialHeight = arrange(dataOrder).height;
  let visual = [...dataOrder];

  const step = (point: { x: number; y: number }): string[] => {
    const grid = arrange(visual);
    const rects = new Map<string, Box>(grid.rects);
    // 冻结：整棵树不会比拖拽开始时矮
    const treeHeight = frozen ? Math.max(grid.height, initialHeight) : grid.height;
    rects.set(rootZone, box(0, 0, width, treeHeight));
    const hits = detect({
      active: { id: activeId, data, rect: { current: { initial: null, translated: null } } },
      collisionRect: box(point.x - 100, point.y - 22, 200, 44),
      droppableRects: rects,
      droppableContainers: [
        { id: rootZone, data: { current: {} } },
        ...dataOrder.map((id) => ({ id, data })),
      ],
      pointerCoordinates: point,
    } as unknown as Args);
    const overId = hits[0] ? String(hits[0].id) : null;
    const drop = overId ? resolveDrop(activeId, overId, layout, [], containers) : null;
    visual = previewItemOrder(ROOT_CONTAINER_ID, dataOrder, null, previewReorder(drop, containers));
    return visual.map((id) => id.slice('node:'.length));
  };
  return { step, initialHeight, width };
}

/** 指针停在 `point` 不动（容器高度冻结），回路跑 10 圈，返回每一圈之后的预览顺序 */
function hold(scene: Scene, detect: CollisionDetection, point: { x: number; y: number }) {
  const sim = simulate(scene, detect, true);
  return Array.from({ length: 10 }, () => sim.step(point).join(','));
}

/** 预览顺序变了几次（第一圈从数据顺序变成落点的那一次也算） */
function changes(history: readonly string[], initial: string): number {
  let count = 0;
  let previous = initial;
  for (const entry of history) {
    if (entry !== previous) count += 1;
    previous = entry;
  }
  return count;
}

/** 族 (a)：回流让网格少一行，指针所在的那一行消失了 */
const SHRINKING_ROWS: Scene = {
  items: [
    { id: 'X', span: 1, height: 200 },
    { id: 'A', span: 2, height: 200 },
    { id: 'B', span: 1, height: 200 },
  ],
  columns: 2,
  active: 'X',
};
// 初始三行 X / A / B；指针在第三行 B 的左半区
const SHRINKING_POINT = { x: 100, y: 2 * (200 + GAP) + 100 };

/** 族 (b)：回流重组了行，行高变了，同一个指针位置在两种排布里压着不同的磁贴 */
const RECOMPOSED_ROWS: Scene = {
  items: [
    { id: 'X', span: 1, height: 60 },
    { id: 'T1', span: 1, height: 60 },
    { id: 'T2', span: 1, height: 300 },
    { id: 'T3', span: 1, height: 60 },
  ],
  columns: 2,
  active: 'X',
};
const RECOMPOSED_POINT = { x: 500, y: 100 };

describe('回路里的振荡场景（指针不动）', () => {
  test('族 (a)：行数变少。不冻结高度时指针掉出整棵树，预览撤销又恢复，来回翻', () => {
    const sim = simulate(SHRINKING_ROWS, deviceFolderCollisionDetection, false);
    const history = Array.from({ length: 6 }, () => sim.step(SHRINKING_POINT).join(','));
    expect(history).toEqual(['A,X,B', 'X,A,B', 'A,X,B', 'X,A,B', 'A,X,B', 'X,A,B']);
  });

  test('族 (a)：冻结高度 + 迟滞 → 第一圈定下落点之后不再变', () => {
    const { detect } = createDeviceFolderCollisionDetection();
    const history = hold(SHRINKING_ROWS, detect, SHRINKING_POINT);
    expect(new Set(history)).toEqual(new Set(['A,X,B']));
  });

  test('族 (b)：行高重组。无状态判定在两种排布之间互翻（冻结高度救不了它）', () => {
    const history = hold(RECOMPOSED_ROWS, deviceFolderCollisionDetection, RECOMPOSED_POINT);
    expect(history.slice(0, 4)).toEqual(['T1,T2,X,T3', 'T1,X,T2,T3', 'T1,T2,X,T3', 'T1,X,T2,T3']);
  });

  test('族 (b)：迟滞 → 指针不动就沿用第一次的落点', () => {
    const { detect } = createDeviceFolderCollisionDetection();
    const history = hold(RECOMPOSED_ROWS, detect, RECOMPOSED_POINT);
    expect(new Set(history)).toEqual(new Set(['T1,T2,X,T3']));
  });

  test('族 (b)：手抖几个像素（不到阈值）也不翻；挪够了才换，换完又稳住', () => {
    const { detect } = createDeviceFolderCollisionDetection();
    const sim = simulate(RECOMPOSED_ROWS, detect, true);
    const jitter = [0, 1, -1, 2, -2, 2, 0].map((d) => ({ x: 500 + d, y: 100 - d }));
    const shaky = jitter.map((point) => sim.step(point).join(','));
    expect(new Set(shaky)).toEqual(new Set(['T1,T2,X,T3']));
    // 往右挪 6px：重算一次，之后停住不动
    const moved = Array.from({ length: 6 }, () => sim.step({ x: 506, y: 100 }).join(','));
    expect(new Set(moved).size).toBe(1);
  });
});

describe('随机场景：冻结高度 + 迟滞下指针不动时预览最多变一次', () => {
  // 线性同余：固定种子，结果可复现
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;

  function randomScene(columns: number, mixedSpans: boolean, mixedHeights: boolean): Scene {
    const count = 3 + Math.floor(random() * 5);
    const items = Array.from({ length: count }, (_, index) => ({
      id: `n${index}`,
      span: mixedSpans ? pick([1, 2, 3]) : 1,
      height: mixedHeights ? pick([60, 200, 228]) : 200,
    }));
    return { items, columns, active: `n${Math.floor(random() * count)}` };
  }

  const variants: [string, number, boolean, boolean][] = [
    ['跨度、高度都一致，两列', 2, false, false],
    ['跨度混排，两列', 2, true, false],
    ['跨度混排，三列', 3, true, false],
    ['高度不一，两列', 2, false, true],
    ['高度不一，三列', 3, false, true],
    ['跨度、高度都混排，三列', 3, true, true],
  ];

  for (const [label, columns, mixedSpans, mixedHeights] of variants) {
    test(label, () => {
      let oscillating = 0;
      for (let trial = 0; trial < 400; trial += 1) {
        const scene = randomScene(columns, mixedSpans, mixedHeights);
        const { detect } = createDeviceFolderCollisionDetection();
        const sim = simulate(scene, detect, true);
        const point = { x: random() * sim.width, y: random() * sim.initialHeight };
        const initial = scene.items.map((item) => item.id).join(',');
        const history = Array.from({ length: 12 }, () => sim.step(point).join(','));
        if (changes(history, initial) > 1) oscillating += 1;
      }
      expect(oscillating).toBe(0);
    });
  }

  test('对照：同样的随机场景用无状态判定确实会振荡（迟滞不是摆设）', () => {
    let oscillating = 0;
    for (let trial = 0; trial < 400; trial += 1) {
      const scene = randomScene(2, false, true);
      const sim = simulate(scene, deviceFolderCollisionDetection, true);
      const point = { x: random() * sim.width, y: random() * sim.initialHeight };
      const initial = scene.items.map((item) => item.id).join(',');
      const history = Array.from({ length: 12 }, () => sim.step(point).join(','));
      if (changes(history, initial) > 1) oscillating += 1;
    }
    expect(oscillating).toBeGreaterThan(0);
  });
});
