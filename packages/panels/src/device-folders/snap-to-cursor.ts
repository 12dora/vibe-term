// DragOverlay 的定位修正：dnd-kit 把 overlay 摆在**被拖元素**的矩形上（这里的被拖元素是
// 整个节点分组：分组头 + 卡片网格，横跨整行），overlay 里画的却是一张小卡片，
// 于是预览会离指针很远。把 overlay 的中心吸到按下点上即可（等价于官方
// `@dnd-kit/modifiers` 的 `snapCenterToCursor`，该包没有安装，这里自带一份）。

import type { Modifier } from '@dnd-kit/core';
import { getEventCoordinates } from '@dnd-kit/utilities';

export interface SnapRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SnapPoint {
  x: number;
  y: number;
}

export interface SnapTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

/**
 * `transform` 是相对按下点的位移，`rect` 是 overlay 当前所在的矩形（未加位移），
 * `cursor` 是按下点的视口坐标。补上「按下点 → 矩形中心」的差值，overlay 的中心就落在指针上，
 * 之后随 `transform` 一起跟手。
 */
export function snapToCursorTransform(
  transform: SnapTransform,
  rect: SnapRect | null,
  cursor: SnapPoint | null
): SnapTransform {
  if (!rect || !cursor) return transform;
  return {
    ...transform,
    x: transform.x + (cursor.x - rect.left) - rect.width / 2,
    y: transform.y + (cursor.y - rect.top) - rect.height / 2,
  };
}

export const snapCenterToCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) =>
  snapToCursorTransform(
    transform,
    draggingNodeRect,
    activatorEvent ? getEventCoordinates(activatorEvent) : null
  );
