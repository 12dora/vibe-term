// 分组列表的碰撞判定。
//
// 落点矩形是层层嵌套的（整棵树 ⊃ 分组本体 ⊃ 分组头 / 条目），一次 `pointerWithin` 把它们
// 混在一起排序，指针停在两个兄弟之间的空隙时就会掉到外层的容器矩形上：同容器重排被判成
// 「原地追加」（无效，整次拖拽白拖），跨容器只能追加到末尾，拖分组停在分组之间的空隙则
// 落到整棵树上（排到末尾）。
//
// 所以分两步：先用 `pointerWithin` 定下**指针所在的容器**（分组本体 → 整棵树），再在该容器
// 的兄弟条目里按指针位置挑一个。
//
// 拖节点（节点列表是会换行的网格，见 `node-grid.ts`）：落点一律是「插入位置」——按阅读顺序
// 找第一个排在指针之后的兄弟，插到它前面；一个都没有就是末尾。算的时候**不看被拖节点自己**
// （也不看占位条，它本来就不是落点）：预览会真的回流（同容器挪被拖节点的 `order`，跨容器插
// 占位条），排在插入位置之前的兄弟不会被挤动，之后的只会往后挪，所以这条规则不会因为回流
// 而来回抖。
//  - 跨容器：直接返回那个兄弟（`resolveDrop` 把「落在节点上」解成「插到它的位置」）；没有
//    就退回容器本身（= 追加到末尾）。
//  - 同容器：`resolveDrop` 对同容器用的是 sortable 的「占谁的位置」语义，所以把插入位置换算
//    成「挪完之后被拖节点所在下标上原来的那个条目」再返回（见 `reorderTargetId`）；换算出来
//    是它自己就等于没动。
// 拖分组（整行宽、上下排列，仍用 sortable 的位移预览）：指针压着谁就是谁，空隙归最近的。
//
// 键盘拖拽没有指针坐标：`sortableKeyboardCoordinates` 每按一次方向键就把预览卡片的左上角对到
// 目标条目的左上角，所以取**包含这个角**的条目（比中心距离可靠：整行宽的磁贴中心离它的左上角
// 有半个容器远）；一个都不包含才退回最近四角。带状态的版本（`create…`）还会在卡片没动时
// 沿用上一次的结果，占位条挤动兄弟也不会让落点自己跳走。
// 容器里没有兄弟（空分组 / 空根层）退回容器本身。指针在整棵树之外返回空，视为取消。

import { closestCorners, pointerWithin } from '@dnd-kit/core';
import type { ClientRect, Collision, CollisionDetection, DroppableContainer } from '@dnd-kit/core';
import {
  ROOT_CONTAINER_ID,
  collisionGroupIds,
  dropZoneId,
  parseNodeElementId,
} from './folder-tree-model';

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

/** 键盘拖拽取落点用的探针：预览卡片左上角往里收一点，贴边对齐时的亚像素误差不至于落到外面 */
const KEYBOARD_PROBE_INSET = 2;

function containerIdOf(container: { data?: { current?: unknown } }): string | null {
  const data = container.data?.current as Partial<SortableItemData> | undefined;
  return typeof data?.containerId === 'string' ? data.containerId : null;
}

function bottomStrip(rect: ClientRect): ClientRect {
  const height = Math.min(rect.height, KEYBOARD_ROOT_STRIP_HEIGHT);
  return { ...rect, top: rect.bottom - height, height };
}

/** 被拖节点所在容器的数据顺序（sortable 挂在 droppable data 上的 `items`）；拿不到返回 null */
function sortableOrder(active: { data?: { current?: unknown } }): string[] | null {
  const data = active.data?.current as { sortable?: { items?: unknown } } | undefined;
  const items = data?.sortable?.items;
  return Array.isArray(items) ? items.map(String) : null;
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

/**
 * 同容器重排：把「插到 `beforeId` 前面」（null = 末尾）换算成 sortable 语义下该落在谁身上。
 * `order` 是容器的数据顺序（含被拖节点）。被拖节点挪完之后的下标就是 `beforeId` 在「去掉
 * 被拖节点的列表」里的下标，而 sortable 的「落在 X 上」= 挪到 X 现在的下标，所以答案是
 * `order` 里那个下标上的条目；是它自己就等于原地不动。
 */
export function reorderTargetId(
  order: readonly string[],
  activeId: string,
  beforeId: string | null
): string {
  const others = order.filter((id) => id !== activeId);
  const insertAt = beforeId === null ? others.length : others.indexOf(beforeId);
  if (insertAt < 0) return activeId;
  return order[insertAt] ?? activeId;
}

/** 包含这个点的条目；嵌套 / 重叠时取面积最小（最具体）的那个 */
export function containingTile(
  point: CollisionPoint,
  tiles: readonly CollisionTile[]
): CollisionTile | null {
  let best: CollisionTile | null = null;
  for (const tile of tiles) {
    if (rectDistance(point, tile.rect) > 0) continue;
    const smaller =
      best === null || tile.rect.width * tile.rect.height < best.rect.width * best.rect.height;
    if (smaller) best = tile;
  }
  return best;
}

function pickContainers(args: Args, allowed: readonly string[]): DroppableContainer[] {
  const set = new Set(allowed);
  return args.droppableContainers.filter((container) => set.has(String(container.id)));
}

function toTiles(
  rects: Args['droppableRects'],
  containers: readonly DroppableContainer[]
): CollisionTile[] {
  const tiles: CollisionTile[] = [];
  for (const container of containers) {
    const rect = rects.get(container.id);
    if (rect) tiles.push({ id: String(container.id), rect });
  }
  return tiles;
}

function collisionFor(id: string | null, containers: readonly DroppableContainer[]): Collision[] {
  const droppableContainer =
    id === null ? undefined : containers.find((container) => String(container.id) === id);
  return droppableContainer
    ? [{ id: droppableContainer.id, data: { droppableContainer, value: 0 } }]
    : [];
}

type Groups = ReturnType<typeof collisionGroupIds>;

function keyboardCollisions(args: Args, groups: Groups): Collision[] {
  const rootZone = dropZoneId(ROOT_CONTAINER_ID);
  const candidates = pickContainers(args, [
    ...groups.zones,
    ...groups.items,
    String(args.active.id),
  ]);
  const probe = {
    x: args.collisionRect.left + KEYBOARD_PROBE_INSET,
    y: args.collisionRect.top + KEYBOARD_PROBE_INSET,
  };
  const hit = containingTile(probe, toTiles(args.droppableRects, candidates));
  if (hit) return collisionFor(hit.id, candidates);

  const activeContainerId = containerIdOf(args.active);
  const rootRect = args.droppableRects.get(rootZone);
  // 节点在分组里时把根落点区也放进候选：根层没有兄弟节点的话，候选里根本没有任何指向根
  // 容器的落点，键盘用户就永远出不了分组（「移出分组」按钮已经删掉了）。整棵树的矩形太大，
  // 只认树底部的一条窄带，而且排在真正的条目之后。
  const inFolder = activeContainerId !== null && activeContainerId !== ROOT_CONTAINER_ID;
  if (!rootRect || !inFolder || groups.root.length === 0) {
    return closestCorners({ ...args, droppableContainers: candidates });
  }
  const roots = pickContainers(args, groups.root);
  const strip = bottomStrip(rootRect);
  if (rectDistance(probe, strip) === 0) return collisionFor(rootZone, roots);
  const rects = new Map(args.droppableRects);
  rects.set(rootZone, strip);
  return closestCorners({
    ...args,
    droppableRects: rects,
    droppableContainers: [...candidates, ...roots],
  });
}

/** 被拖元素来自别的容器（目标容器里会插占位条）；拖分组、或量不到来源容器时不算 */
function isCrossing(args: Args, containerId: string): boolean {
  const activeContainerId = containerIdOf(args.active);
  return activeContainerId !== null && activeContainerId !== containerId;
}

/** 指针在 `flow.containerId` 这个容器里时该落在哪个兄弟上；null = 落到容器本身 */
function pointerTargetId(
  args: Args,
  point: CollisionPoint,
  tiles: readonly CollisionTile[],
  flow: { containerId: string; width?: number }
): string | null {
  const activeId = String(args.active.id);
  if (isCrossing(args, flow.containerId)) {
    return insertionTile(point, tiles, flow.width)?.id ?? null;
  }
  const order = parseNodeElementId(activeId) === null ? null : sortableOrder(args.active);
  // 拖分组，或拿不到数据顺序：指针压着谁就是谁
  if (!order) return nearestTile(point, tiles)?.id ?? null;
  const others = tiles.filter((tile) => tile.id !== activeId);
  return reorderTargetId(order, activeId, insertionTile(point, others, flow.width)?.id ?? null);
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

  // 被拖元素自己（原位变暗的那个）也是候选：换算出来「原地不动」时要能选中它自己
  const siblings = pickContainers(args, [...groups.items, String(args.active.id)]).filter(
    (container) => containerIdOf(container) === containerId
  );
  const targetId = pointerTargetId(args, point, toTiles(args.droppableRects, siblings), {
    containerId,
    width: args.droppableRects.get(containerHit.id)?.width,
  });
  const hits = collisionFor(targetId, siblings);
  return hits.length > 0 ? hits : fallback;
}

function detect(args: Args): Collision[] {
  const ids = args.droppableContainers.map((container) => String(container.id));
  const groups = collisionGroupIds(String(args.active.id), ids);
  return args.pointerCoordinates
    ? pointerCollisions(args, groups, args.pointerCoordinates)
    : keyboardCollisions(args, groups);
}

/** 无状态的判定：同样的输入永远给同样的结果（单测用它） */
export const deviceFolderCollisionDetection: CollisionDetection = detect;

/** 键盘落点的锁：预览卡片停在哪（取整到像素）+ 当时选中的落点 */
export function keyboardLatchKey(activeId: string, rect: { left: number; top: number }): string {
  return `${activeId}@${Math.round(rect.left)},${Math.round(rect.top)}`;
}

/**
 * 给 `DndContext` 用的判定（每棵树建一个）。键盘拖拽时落点只在预览卡片**真的挪了位置**（按了
 * 方向键 / 页面滚动）时才重新算：跨容器的占位条会把目标兄弟挤走，卡片底下换了人，照几何
 * 重算会让落点自己跳到别处；卡片没动就沿用上一次的落点。指针拖拽不上锁（那边的规则本身
 * 不受回流影响）。
 */
export function createDeviceFolderCollisionDetection(): CollisionDetection {
  let latch: { key: string; id: string } | null = null;
  return (args) => {
    if (args.pointerCoordinates) {
      latch = null;
      return detect(args);
    }
    const key = keyboardLatchKey(String(args.active.id), args.collisionRect);
    const held = latch?.key === key ? collisionFor(latch.id, args.droppableContainers) : [];
    if (held.length > 0) return held;
    const hits = detect(args);
    const first = hits[0];
    latch = first ? { key, id: String(first.id) } : null;
    return hits;
  };
}
