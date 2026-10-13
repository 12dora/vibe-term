// 分组列表的碰撞判定。
//
// 落点矩形是层层嵌套的（整棵树 ⊃ 分组本体 ⊃ 分组头 / 条目），一次 `pointerWithin` 把它们
// 混在一起排序，指针停在两个兄弟之间的空隙时就会掉到外层的容器矩形上：同容器重排被判成
// 「原地追加」（无效，整次拖拽白拖），跨容器只能追加到末尾，拖分组停在分组之间的空隙则
// 落到整棵树上（排到末尾）。
//
// 所以分两步：先用 `pointerWithin` 定下**指针所在的容器**（分组本体 → 整棵树），再在该容器
// 的兄弟条目里按指针位置挑一个。节点列表是会换行的网格（见 `node-grid.ts`），兄弟不再只是
// 上下排列，两种拖法各有各的挑法：
//  - 同容器重排（没有占位条，靠 sortable 的 transform 腾位置）：指针压着谁就是谁；停在空隙
//    或行尾空白时，先在**同一行**里找水平最近的，这一行没有兄弟才按到矩形的距离找最近的。
//  - 跨容器（目标容器里插占位条）：落点是「插入位置」——按阅读顺序找第一个排在指针之后的
//    兄弟，插到它前面；一个都没有就退回容器本身（= 追加到末尾）。排在插入位置之前的兄弟不会
//    被占位条挤动，之后的只会往后挪，所以这条规则不会因为占位条插进来而来回抖。
// 容器里没有兄弟（空分组 / 空根层）退回容器本身。指针在整棵树之外返回空，视为取消。

import { closestCenter, pointerWithin } from '@dnd-kit/core';
import type { ClientRect, Collision, CollisionDetection, DroppableContainer } from '@dnd-kit/core';
import { ROOT_CONTAINER_ID, collisionGroupIds, dropZoneId } from './folder-tree-model';

/** 挂在每个可排序条目的 droppable 上：它属于哪个容器（碰撞判定要按容器筛兄弟） */
export interface SortableItemData {
  containerId: string;
}

export interface CollisionPoint {
  x: number;
  y: number;
}

/** 参与挑选的一个兄弟条目：id + 它当前量到的布局矩形 */
export interface CollisionTile {
  id: string;
  rect: ClientRect;
}

type Args = Parameters<CollisionDetection>[0];

/**
 * 键盘拖拽时替根落点区用的矩形高度。整棵树的矩形太大，直接参与最近中心会把每一步都吸成
 * 「移到最外层」；换成树底部的一条窄带，只有一路按到底才会命中。
 */
const KEYBOARD_ROOT_STRIP_HEIGHT = 56;

/**
 * 条目宽度占到容器宽度的这个比例以上就算「独占一行」：指针压在它身上时按上下半区分前后，
 * 否则（一行里并排着几个）按左右半区分。两列时单格约占一半，三列里跨两格的约占三分之二。
 */
const FULL_ROW_RATIO = 0.75;

function containerIdOf(container: { data?: { current?: unknown } }): string | null {
  const data = container.data?.current as Partial<SortableItemData> | undefined;
  return typeof data?.containerId === 'string' ? data.containerId : null;
}

function bottomStrip(rect: ClientRect): ClientRect {
  const height = Math.min(rect.height, KEYBOARD_ROOT_STRIP_HEIGHT);
  return { ...rect, top: rect.bottom - height, height };
}

function inRowBand(point: CollisionPoint, rect: ClientRect): boolean {
  return point.y >= rect.top && point.y <= rect.bottom;
}

/** 点到矩形的距离；点在矩形里为 0 */
function rectDistance(point: CollisionPoint, rect: ClientRect): number {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
  return Math.hypot(dx, dy);
}

function centerDistance(point: CollisionPoint, rect: ClientRect): number {
  return Math.hypot(rect.left + rect.width / 2 - point.x, rect.top + rect.height / 2 - point.y);
}

/**
 * 同容器重排的落点：指针压着的条目；不在任何条目上时同一行优先（行尾空白归这一行的最后一个，
 * 而不是正上方那一个），再按到矩形的距离取最近，距离相同比中心。
 */
export function nearestTile(
  point: CollisionPoint,
  tiles: readonly CollisionTile[]
): CollisionTile | null {
  const band = tiles.filter((tile) => inRowBand(point, tile.rect));
  const pool = band.length > 0 ? band : tiles;
  let best: CollisionTile | null = null;
  let bestScore: [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  for (const tile of pool) {
    const score: [number, number] = [
      rectDistance(point, tile.rect),
      centerDistance(point, tile.rect),
    ];
    if (score[0] < bestScore[0] || (score[0] === bestScore[0] && score[1] < bestScore[1])) {
      best = tile;
      bestScore = score;
    }
  }
  return best;
}

/** 按阅读顺序（先行后列），这个条目是不是排在指针之后 */
function readsAfter(point: CollisionPoint, rect: ClientRect, flowWidth: number): boolean {
  if (rect.top > point.y) return true;
  if (rect.bottom < point.y) return false;
  if (point.x < rect.left) return true;
  if (point.x > rect.right) return false;
  // 指针压在条目身上：独占一行的看上下半区，并排的看左右半区
  return rect.width >= flowWidth * FULL_ROW_RATIO
    ? point.y < rect.top + rect.height / 2
    : point.x < rect.left + rect.width / 2;
}

function tilesExtent(tiles: readonly CollisionTile[]): number {
  if (tiles.length === 0) return 0;
  const left = Math.min(...tiles.map((tile) => tile.rect.left));
  const right = Math.max(...tiles.map((tile) => tile.rect.right));
  return right - left;
}

/**
 * 跨容器插入的落点：第一个排在指针之后的条目（插到它前面）；返回 null = 指针在所有条目
 * 之后，追加到末尾。`flowWidth` 是容器的宽度，量不到时用条目们铺开的宽度代替。
 */
export function insertionTile(
  point: CollisionPoint,
  tiles: readonly CollisionTile[],
  flowWidth?: number
): CollisionTile | null {
  const width = flowWidth && flowWidth > 0 ? flowWidth : tilesExtent(tiles);
  let first: CollisionTile | null = null;
  for (const tile of tiles) {
    if (!readsAfter(point, tile.rect, width)) continue;
    const earlier =
      first === null ||
      tile.rect.top < first.rect.top ||
      (tile.rect.top === first.rect.top && tile.rect.left < first.rect.left);
    if (earlier) first = tile;
  }
  return first;
}

function pickContainers(args: Args, allowed: readonly string[]): DroppableContainer[] {
  const set = new Set(allowed);
  return args.droppableContainers.filter((container) => set.has(String(container.id)));
}

function toTiles(args: Args, containers: readonly DroppableContainer[]): CollisionTile[] {
  const tiles: CollisionTile[] = [];
  for (const container of containers) {
    const rect = args.droppableRects.get(container.id);
    if (rect) tiles.push({ id: String(container.id), rect });
  }
  return tiles;
}

function collisionOf(tile: CollisionTile, containers: readonly DroppableContainer[]): Collision[] {
  const droppableContainer = containers.find((container) => String(container.id) === tile.id);
  return droppableContainer
    ? [{ id: droppableContainer.id, data: { droppableContainer, value: 0 } }]
    : [];
}

type Groups = ReturnType<typeof collisionGroupIds>;

/** 键盘拖拽没有指针坐标（`pointerWithin` 恒为空），只能退回最近中心 */
function keyboardCollisions(args: Args, groups: Groups): Collision[] {
  const rootZone = dropZoneId(ROOT_CONTAINER_ID);
  const candidates = pickContainers(args, [
    ...groups.zones,
    ...groups.items,
    String(args.active.id),
  ]);
  const activeContainerId = containerIdOf(args.active);
  const rootRect = args.droppableRects.get(rootZone);
  // 节点在分组里时把根落点区也放进候选：根层没有兄弟节点的话，候选里根本没有任何指向根
  // 容器的落点，键盘用户就永远出不了分组（「移出分组」按钮已经删掉了）。
  if (
    activeContainerId !== null &&
    activeContainerId !== ROOT_CONTAINER_ID &&
    groups.root.length > 0 &&
    rootRect
  ) {
    const rects = new Map(args.droppableRects);
    rects.set(rootZone, bottomStrip(rootRect));
    return closestCenter({
      ...args,
      droppableRects: rects,
      droppableContainers: [...candidates, ...pickContainers(args, groups.root)],
    });
  }
  return closestCenter({ ...args, droppableContainers: candidates });
}

/** 被拖元素来自别的容器（目标容器里会插占位条）；拖分组、或量不到来源容器时不算 */
function isCrossing(args: Args, containerId: string): boolean {
  const activeContainerId = containerIdOf(args.active);
  return activeContainerId !== null && activeContainerId !== containerId;
}

function chooseTile(
  point: CollisionPoint,
  tiles: readonly CollisionTile[],
  mode: { crossing: boolean; flowWidth?: number }
): CollisionTile | null {
  return mode.crossing ? insertionTile(point, tiles, mode.flowWidth) : nearestTile(point, tiles);
}

function pointerCollisions(args: Args, groups: Groups, point: CollisionPoint): Collision[] {
  // 放置区（分组头 / 空分组内容区）最先判，免得被它内部的兄弟条目抢走
  const zoneHits = pointerWithin({
    ...args,
    droppableContainers: pickContainers(args, groups.zones),
  });
  if (zoneHits.length > 0) return zoneHits;

  const containerHits = pointerWithin({
    ...args,
    droppableContainers: pickContainers(args, groups.containers),
  });
  const rootHits = pointerWithin({
    ...args,
    droppableContainers: pickContainers(args, groups.root),
  });
  // 分组本体先于整棵树：指针在分组里就是这个分组，不是最外层
  const fallback = containerHits.length > 0 ? containerHits : rootHits;
  const containerHit = fallback[0];
  // 指针在整棵树之外：over 为空 = 取消
  if (!containerHit) return [];
  const containerId = containerHits.length > 0 ? String(containerHit.id) : ROOT_CONTAINER_ID;

  // 被拖元素自己（原位变暗的那个）也要参与（键盘分支同理）：指针回到原来的位置时选中自己，
  // sortable 才会把已经退避的兄弟归位——否则最近的永远是邻居，邻居一直占着原位不回来。
  const siblings = pickContainers(args, [...groups.items, String(args.active.id)]).filter(
    (container) => containerIdOf(container) === containerId
  );
  const flowWidth = args.droppableRects.get(containerHit.id)?.width;
  const target = chooseTile(point, toTiles(args, siblings), {
    crossing: isCrossing(args, containerId),
    flowWidth,
  });
  return target ? collisionOf(target, siblings) : fallback;
}

export const deviceFolderCollisionDetection: CollisionDetection = (args) => {
  const ids = args.droppableContainers.map((container) => String(container.id));
  const groups = collisionGroupIds(String(args.active.id), ids);
  return args.pointerCoordinates
    ? pointerCollisions(args, groups, args.pointerCoordinates)
    : keyboardCollisions(args, groups);
};
