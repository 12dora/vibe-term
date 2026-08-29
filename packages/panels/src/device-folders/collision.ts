// 分组列表的碰撞判定。
//
// 落点矩形是层层嵌套的（整棵树 ⊃ 分组本体 ⊃ 分组头 / 条目），一次 `pointerWithin` 把它们
// 混在一起排序，指针停在两个兄弟之间的空隙时就会掉到外层的容器矩形上：同容器重排被判成
// 「原地追加」（无效，整次拖拽白拖），跨容器只能追加到末尾，拖分组停在分组之间的空隙则
// 落到整棵树上（排到末尾）。
//
// 所以分两步：先用 `pointerWithin` 定下**指针所在的容器**（分组本体 → 整棵树），再在该容器
// 的兄弟条目里取最近中心——空隙自然归给相邻的那一个，落点下标永远是真实位置。容器里没有
// 兄弟（空分组 / 空根层）才退回容器本身（= 追加）。指针在整棵树之外返回空，视为取消。

import { closestCenter, pointerWithin } from '@dnd-kit/core';
import type { ClientRect, CollisionDetection } from '@dnd-kit/core';
import { ROOT_CONTAINER_ID, collisionGroupIds, dropZoneId } from './folder-tree-model';

/** 挂在每个可排序条目的 droppable 上：它属于哪个容器（碰撞判定要按容器筛兄弟） */
export interface SortableItemData {
  containerId: string;
}

/**
 * 键盘拖拽时替根落点区用的矩形高度。整棵树的矩形太大，直接参与最近中心会把每一步都吸成
 * 「移到最外层」；换成树底部的一条窄带，只有一路按到底才会命中。
 */
const KEYBOARD_ROOT_STRIP_HEIGHT = 56;

function containerIdOf(container: { data?: { current?: unknown } }): string | null {
  const data = container.data?.current as Partial<SortableItemData> | undefined;
  return typeof data?.containerId === 'string' ? data.containerId : null;
}

function bottomStrip(rect: ClientRect): ClientRect {
  const height = Math.min(rect.height, KEYBOARD_ROOT_STRIP_HEIGHT);
  return { ...rect, top: rect.bottom - height, height };
}

export const deviceFolderCollisionDetection: CollisionDetection = (args) => {
  const ids = args.droppableContainers.map((container) => String(container.id));
  const groups = collisionGroupIds(String(args.active.id), ids);
  const pick = (allowed: readonly string[]) => {
    const set = new Set(allowed);
    return args.droppableContainers.filter((container) => set.has(String(container.id)));
  };
  const rootZone = dropZoneId(ROOT_CONTAINER_ID);

  // 键盘拖拽没有指针坐标（`pointerWithin` 恒为空），只能退回最近中心。
  if (!args.pointerCoordinates) {
    const candidates = pick([...groups.zones, ...groups.items]);
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
        droppableContainers: [...candidates, ...pick(groups.root)],
      });
    }
    return closestCenter({ ...args, droppableContainers: candidates });
  }

  // 放置区（分组头 / 空分组内容区）最先判，免得被它内部的兄弟条目抢走
  const zoneHits = pointerWithin({ ...args, droppableContainers: pick(groups.zones) });
  if (zoneHits.length > 0) return zoneHits;

  const containerHits = pointerWithin({ ...args, droppableContainers: pick(groups.containers) });
  const rootHits = pointerWithin({ ...args, droppableContainers: pick(groups.root) });
  // 分组本体先于整棵树：指针在分组里就是这个分组，不是最外层
  const containerId =
    containerHits.length > 0
      ? String(containerHits[0]?.id)
      : rootHits.length > 0
        ? ROOT_CONTAINER_ID
        : null;
  // 指针在整棵树之外：over 为空 = 取消
  if (containerId === null) return [];

  const siblings = pick(groups.items).filter(
    (container) => containerIdOf(container) === containerId
  );
  if (siblings.length > 0) return closestCenter({ ...args, droppableContainers: siblings });
  return containerHits.length > 0 ? containerHits : rootHits;
};
