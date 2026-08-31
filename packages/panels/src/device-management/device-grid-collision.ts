// 设备卡片网格的碰撞判定。
//
// `closestCenter` 只排序、不设上限：卡片被拖到网格外很远的地方，仍然一定会选出一个「最近」
// 的兄弟，于是整排卡片跟着避让——像 iOS 桌面那样「靠近了才让位」的手感就没了。
//
// 这里先按半径筛一遍候选，再把剩下的交给 `closestCenter`：
//   - 半径取 max(96, 拖拽矩形对角线的一半)。一屏两列的卡片间距是「卡片宽 + gap」，半个对角线
//     略大于半个间距，所以相邻卡片的正常交换点完全不受影响，被砍掉的只有远处那些。
//   - 被拖的卡片自己永远留在候选里：拖远时命中的是它自己（兄弟归位），而不是 over 为空来回抖。
//   - 键盘拖拽没有指针坐标，碰撞矩形是一步步挪的，筛半径会把候选清空导致按键没有反馈，
//     所以直接退回 `closestCenter`。

import { closestCenter } from '@dnd-kit/core';
import type { ClientRect, CollisionDetection } from '@dnd-kit/core';

/** 卡片很小时的兜底半径，保证短距离内仍能触发避让 */
export const DEVICE_GRID_MIN_PROXIMITY_RADIUS = 96;

function centerOf(rect: ClientRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export function deviceGridProximityRadius(rect: ClientRect): number {
  return Math.max(DEVICE_GRID_MIN_PROXIMITY_RADIUS, Math.hypot(rect.width, rect.height) / 2);
}

export const deviceGridCollisionDetection: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) return closestCenter(args);

  const activeId = String(args.active.id);
  const activeCenter = centerOf(args.collisionRect);
  const radius = deviceGridProximityRadius(args.collisionRect);

  const candidates = args.droppableContainers.filter((container) => {
    if (String(container.id) === activeId) return true;
    const rect = args.droppableRects.get(container.id);
    if (!rect) return false;
    const center = centerOf(rect);
    return Math.hypot(center.x - activeCenter.x, center.y - activeCenter.y) <= radius;
  });

  return closestCenter({ ...args, droppableContainers: candidates });
};
