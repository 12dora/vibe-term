import { describe, expect, test } from 'bun:test';
import type { DragEndEvent } from '@dnd-kit/core';
import { closestCenter } from '@dnd-kit/core';
import {
  pointerFirstCollisionDetection,
  reorderIdsByDragEnd,
  restrictToVerticalAxis,
} from './device-tree-dnd-impl';

const dragEvent = (activeId: string, overId: string | null) =>
  ({
    active: { id: activeId },
    over: overId === null ? null : { id: overId },
  }) as DragEndEvent;

describe('reorderIdsByDragEnd', () => {
  const ids = ['a', 'b', 'c', 'd'];

  test('moves the dragged id to the drop target index', () => {
    expect(reorderIdsByDragEnd(ids, dragEvent('a', 'c'))).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderIdsByDragEnd(ids, dragEvent('d', 'a'))).toEqual(['d', 'a', 'b', 'c']);
  });

  test('does not mutate the input order', () => {
    reorderIdsByDragEnd(ids, dragEvent('a', 'c'));
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });

  test('returns null when there is no drop target', () => {
    expect(reorderIdsByDragEnd(ids, dragEvent('a', null))).toBeNull();
  });

  test('returns null when dropped on itself', () => {
    expect(reorderIdsByDragEnd(ids, dragEvent('b', 'b'))).toBeNull();
  });

  test('returns null when either id is unknown', () => {
    expect(reorderIdsByDragEnd(ids, dragEvent('z', 'b'))).toBeNull();
    expect(reorderIdsByDragEnd(ids, dragEvent('b', 'z'))).toBeNull();
  });
});

describe('restrictToVerticalAxis', () => {
  const apply = (transform: { x: number; y: number; scaleX: number; scaleY: number }) =>
    restrictToVerticalAxis({ transform } as unknown as Parameters<
      typeof restrictToVerticalAxis
    >[0]);

  test('抹掉横向位移，纵向位移与缩放原样保留', () => {
    expect(apply({ x: 240, y: 60, scaleX: 1, scaleY: 1 })).toEqual({
      x: 0,
      y: 60,
      scaleX: 1,
      scaleY: 1,
    });
    expect(apply({ x: -180, y: -12, scaleX: 0.9, scaleY: 1.1 })).toEqual({
      x: 0,
      y: -12,
      scaleX: 0.9,
      scaleY: 1.1,
    });
  });
});

const rect = (top: number, height: number) => ({
  top,
  bottom: top + height,
  height,
  left: 0,
  right: 200,
  width: 200,
});

/**
 * 侧栏节点分节的真实形状：本机分节展开着设备树（很高），下面跟着一行高的离线分节。
 * 拖动本机分节时 `collisionRect` 是**整块**高矩形，它的中心离矮分节的中心很远。
 */
function collisionArgs(pointerY: number | null, translateY: number) {
  const rects = new Map<string, ReturnType<typeof rect>>([
    ['tall', rect(0, 600)],
    ['short', rect(600, 80)],
  ]);
  return {
    active: { id: 'tall', data: { current: undefined }, rect: { current: {} } },
    collisionRect: rect(translateY, 600),
    droppableRects: rects,
    droppableContainers: [...rects.keys()].map((id) => ({ id })),
    pointerCoordinates: pointerY === null ? null : { x: 100, y: pointerY },
    // 只喂碰撞检测真正会读的字段
  } as unknown as Parameters<typeof pointerFirstCollisionDetection>[0];
}

describe('pointerFirstCollisionDetection', () => {
  test('指针落进矮分节即换目标，不必等高分节的中心挪过去', () => {
    const args = collisionArgs(650, 40);
    expect(pointerFirstCollisionDetection(args)[0]?.id).toBe('short');
    // 对照：仅按中心距离时被拖的高分节还压在自己身上，用户观感就是「拖不动」
    expect(closestCenter(args)[0]?.id).toBe('tall');
  });

  test('指针还在自己身上时不换目标', () => {
    expect(pointerFirstCollisionDetection(collisionArgs(100, 0))[0]?.id).toBe('tall');
  });

  test('指针落在列表外（含键盘排序无指针坐标）退回中心距离，over 不会为空', () => {
    expect(pointerFirstCollisionDetection(collisionArgs(2000, 560))[0]?.id).toBe('short');
    expect(pointerFirstCollisionDetection(collisionArgs(null, 560))[0]?.id).toBe('short');
  });
});
