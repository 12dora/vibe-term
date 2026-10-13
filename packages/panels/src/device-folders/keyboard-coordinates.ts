// 分组列表的键盘方向键：每按一次，预览卡片该挪到哪个条目上。
//
// dnd-kit 自带的 `sortableKeyboardCoordinates` 拿预览卡片（一张很小的卡片）的四个角去比候选
// 条目的四个角：三列网格里整行宽的磁贴右侧两角离得远，会输给隔一行的窄磁贴——从相邻行
// 永远选不到它。这里改成按**行模型**选：
//   - ↓ / ↑：先定下一行 / 上一行（当前条目所在行之下 / 之上、最近的那一行），再在这一行里取
//     水平范围包含预览卡片左边缘的条目，没有就取离它最近的；
//   - → / ←：阅读顺序（先行后列）里的下一个 / 上一个。
// 选中之后把预览卡片的左上角对到目标的左上角，`collision.ts` 的键盘分支据此取落点。
//
// 能停的「站」：拖节点时是节点磁贴（含被拖节点自己的原位）、分组头、空分组内容区；拖分组时
// 是分组。节点在分组里且根层一块磁贴都没有时，再加一站「树底部的窄带」= 移到最外层（否则
// 键盘出不了分组；最后一个分组是收起 / 空的时窄带与它的落点区重叠，会落到那个分组上）。

import type { ClientRect, KeyboardCoordinateGetter } from '@dnd-kit/core';
import {
  type CollisionTile,
  KEYBOARD_PROBE_INSET,
  bottomStrip,
  containerIdOf,
  containingTile,
} from './collision';
import {
  ROOT_CONTAINER_ID,
  collisionGroupIds,
  dropZoneId,
  parseFolderElementId,
} from './folder-tree-model';

export type ArrowDirection = 'up' | 'down' | 'left' | 'right';

const DIRECTION_BY_CODE: Record<string, ArrowDirection> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/** 同一行的条目顶边相同（网格 stretch）；留一点余量吃掉亚像素误差 */
const ROW_EPSILON = 1;

const EMPTY_RECT: ClientRect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };

export interface KeyboardStep {
  direction: ArrowDirection;
  /** 预览卡片的左上角 */
  origin: { left: number; top: number };
  /** 当前的落点（跨容器时它被占位条挤到了卡片旁边，→ 要跳过它） */
  overId: string | null;
}

/** 阅读顺序：先行后列（顶边差在余量内算同一行） */
function byReadingOrder(a: CollisionTile, b: CollisionTile): number {
  const rows = a.rect.top - b.rect.top;
  return Math.abs(rows) > ROW_EPSILON ? rows : a.rect.left - b.rect.left;
}

/** 点到条目水平范围的距离；在范围里为 0 */
function horizontalGap(left: number, rect: ClientRect): number {
  return Math.max(rect.left - left, 0, left - rect.right);
}

/** 一行里水平范围包含 `left` 的条目，没有就取最近的 */
function pickInRow(row: readonly CollisionTile[], left: number): CollisionTile | null {
  let best: CollisionTile | null = null;
  for (const stop of row) {
    if (best === null || horizontalGap(left, stop.rect) < horizontalGap(left, best.rect)) {
      best = stop;
    }
  }
  return best;
}

/**
 * 当前所在行的上下边界：预览卡片压着的条目的行。没压着任何条目（底下是占位条 / 空隙）时，
 * 卡片的顶边就是这一行的顶边：给一条刚好超出余量的窄带，同一行的条目既不算「下面」也不算
 * 「上面」。
 */
function currentBand(step: KeyboardStep, current: CollisionTile | null) {
  return current
    ? { top: current.rect.top, bottom: current.rect.bottom }
    : { top: step.origin.top, bottom: step.origin.top + 2 * ROW_EPSILON };
}

function verticalStop(
  step: KeyboardStep,
  current: CollisionTile | null,
  stops: readonly CollisionTile[]
): CollisionTile | null {
  const band = currentBand(step, current);
  const down = step.direction === 'down';
  const beyond = stops.filter((stop) =>
    down ? stop.rect.top >= band.bottom - ROW_EPSILON : stop.rect.bottom <= band.top + ROW_EPSILON
  );
  const others = beyond.filter((stop) => stop.id !== current?.id);
  if (others.length === 0) return null;
  // 最近的那一行：往下取顶边最小的，往上取顶边最大的
  const tops = others.map((stop) => stop.rect.top);
  const rowTop = down ? Math.min(...tops) : Math.max(...tops);
  const row = others.filter((stop) => Math.abs(stop.rect.top - rowTop) <= ROW_EPSILON);
  return pickInRow(row, step.origin.left);
}

function horizontalStop(
  step: KeyboardStep,
  current: CollisionTile | null,
  stops: readonly CollisionTile[]
): CollisionTile | null {
  const ordered = [...stops].sort(byReadingOrder);
  const forward = step.direction === 'right';
  if (current) {
    const index = ordered.findIndex((stop) => stop.id === current.id);
    return ordered[index + (forward ? 1 : -1)] ?? null;
  }
  // 没压着任何条目：以卡片左上角为界，往后取第一个排在它之后的，往前取最后一个排在它之前的
  const probe: CollisionTile = {
    id: '',
    rect: { ...EMPTY_RECT, left: step.origin.left, top: step.origin.top },
  };
  const after = ordered.filter((stop) => byReadingOrder(stop, probe) >= 0);
  if (!forward) return ordered[ordered.length - after.length - 1] ?? null;
  // 当前落点已经被占位条挤到卡片后面：再选它等于没动，跳到下一个
  return after[0]?.id === step.overId ? (after[1] ?? null) : (after[0] ?? null);
}

/** 按一次方向键之后预览卡片该停在哪一站；那个方向没有可去的地方返回 null */
export function nextKeyboardStop(
  step: KeyboardStep,
  stops: readonly CollisionTile[]
): CollisionTile | null {
  const probe = {
    x: step.origin.left + KEYBOARD_PROBE_INSET,
    y: step.origin.top + KEYBOARD_PROBE_INSET,
  };
  const current = containingTile(probe, stops);
  return step.direction === 'up' || step.direction === 'down'
    ? verticalStop(step, current, stops)
    : horizontalStop(step, current, stops);
}

interface StopSource {
  id: string | number;
  data?: { current?: unknown };
}

/**
 * 这次拖拽能停的站（见文件头）。`rects` 是落点矩形表；`ROOT_STRIP_ID` 那一站的矩形是树底部的
 * 窄带，不是整棵树。
 */
export function keyboardStops(
  active: StopSource,
  containers: readonly StopSource[],
  rects: ReadonlyMap<string | number, ClientRect>
): CollisionTile[] {
  const activeId = String(active.id);
  const groups = collisionGroupIds(
    activeId,
    containers.map((container) => String(container.id))
  );
  const stops: CollisionTile[] = [];
  // 拖分组时分组头落点区与分组本体重叠，只留分组本体一站（落在头上与落在分组上同义）
  const zones = parseFolderElementId(activeId) === null ? groups.zones : [];
  for (const id of [...zones, ...groups.items, activeId]) {
    const rect = rects.get(id);
    if (rect) stops.push({ id, rect });
  }
  const activeContainerId = containerIdOf(active);
  const inFolder = activeContainerId !== null && activeContainerId !== ROOT_CONTAINER_ID;
  const rootHasTiles = containers.some(
    (container) =>
      groups.items.includes(String(container.id)) && containerIdOf(container) === ROOT_CONTAINER_ID
  );
  const rootRect = rects.get(dropZoneId(ROOT_CONTAINER_ID));
  if (inFolder && !rootHasTiles && rootRect) {
    stops.push({ id: dropZoneId(ROOT_CONTAINER_ID), rect: bottomStrip(rootRect) });
  }
  return stops;
}

export const deviceFolderKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const direction = DIRECTION_BY_CODE[event.code];
  if (!direction) return undefined;
  event.preventDefault();
  const { active, collisionRect, droppableRects, droppableContainers, over } = context;
  if (!active || !collisionRect) return undefined;
  const stops = keyboardStops(active, droppableContainers.getEnabled(), droppableRects);
  const next = nextKeyboardStop(
    {
      direction,
      origin: { left: collisionRect.left, top: collisionRect.top },
      overId: over ? String(over.id) : null,
    },
    stops
  );
  return next ? { x: next.rect.left, y: next.rect.top } : undefined;
};
