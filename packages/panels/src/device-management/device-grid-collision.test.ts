// 设备卡片网格的碰撞判定：用假矩形摆一个 2×2 的卡片网格，断言「拖到哪 → over 是谁」。
// 对照组直接跑 dnd-kit 的 `closestCenter`，用来证明差别只出现在远处。

import { describe, expect, test } from 'bun:test';
import { type CollisionDetection, closestCenter } from '@dnd-kit/core';
import { deviceGridCollisionDetection, deviceGridProximityRadius } from './device-grid-collision';

type Args = Parameters<CollisionDetection>[0];

const CARD_WIDTH = 384;
const CARD_HEIGHT = 160;
const GAP = 12;

function rect(left: number, top: number) {
  return {
    left,
    top,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    right: left + CARD_WIDTH,
    bottom: top + CARD_HEIGHT,
  };
}

/** 两列两行：c1 左上、c2 右上、c3 左下、c4 右下 */
const CARDS = {
  c1: rect(0, 0),
  c2: rect(CARD_WIDTH + GAP, 0),
  c3: rect(0, CARD_HEIGHT + GAP),
  c4: rect(CARD_WIDTH + GAP, CARD_HEIGHT + GAP),
};

/** 被拖的卡片从原位平移 (dx, dy)；键盘拖拽传 pointer=false */
function args(activeId: keyof typeof CARDS, dx: number, dy: number, pointer = true): Args {
  const droppableRects = new Map(Object.entries(CARDS));
  const droppableContainers = Object.entries(CARDS).map(([id, value]) => ({
    id,
    key: id,
    disabled: false,
    node: { current: null },
    rect: { current: value },
    data: { current: {} },
  }));
  const origin = CARDS[activeId];
  const collisionRect = rect(origin.left + dx, origin.top + dy);
  return {
    active: {
      id: activeId,
      data: { current: {} },
      rect: { current: { initial: origin, translated: collisionRect } },
    },
    collisionRect,
    droppableRects,
    droppableContainers,
    pointerCoordinates: pointer
      ? { x: collisionRect.left + CARD_WIDTH / 2, y: collisionRect.top + CARD_HEIGHT / 2 }
      : null,
  } as unknown as Args;
}

function overId(activeId: keyof typeof CARDS, dx: number, dy: number, pointer = true) {
  const hits = deviceGridCollisionDetection(args(activeId, dx, dy, pointer));
  return hits.length > 0 ? String(hits[0]?.id) : null;
}

function closestId(activeId: keyof typeof CARDS, dx: number, dy: number) {
  const hits = closestCenter(args(activeId, dx, dy));
  return hits.length > 0 ? String(hits[0]?.id) : null;
}

describe('半径', () => {
  test('取卡片对角线的一半，小卡片兜底 96', () => {
    expect(deviceGridProximityRadius(CARDS.c1)).toBeCloseTo(Math.hypot(384, 160) / 2, 5);
    expect(deviceGridProximityRadius({ ...rect(0, 0), width: 40, height: 40 })).toBe(96);
  });

  test('半径大于到相邻卡片的半个间距：正常交换点不受影响', () => {
    const radius = deviceGridProximityRadius(CARDS.c1);
    expect(radius).toBeGreaterThan((CARD_WIDTH + GAP) / 2);
    expect(radius).toBeGreaterThan((CARD_HEIGHT + GAP) / 2);
  });
});

describe('拖远：兄弟卡片不再避让', () => {
  test('拖到网格右侧很远处 → over 是自己（closestCenter 会误判成 c2）', () => {
    expect(closestId('c1', 900, 0)).toBe('c2');
    expect(overId('c1', 900, 0)).toBe('c1');
  });

  test('拖到网格下方很远处 → over 是自己', () => {
    expect(closestId('c1', 0, 800)).toBe('c3');
    expect(overId('c1', 0, 800)).toBe('c1');
  });

  test('远处只剩自己一个候选，不会出现 over 为空的抖动', () => {
    const hits = deviceGridCollisionDetection(args('c1', 1200, 1200));
    expect(hits.map((hit) => String(hit.id))).toEqual(['c1']);
  });
});

describe('拖近：命中目标卡片', () => {
  test('压在 c3 上 → over 是 c3', () => {
    expect(overId('c1', 0, CARD_HEIGHT + GAP)).toBe('c3');
  });

  test('压在 c2 上 → over 是 c2', () => {
    expect(overId('c1', CARD_WIDTH + GAP, 0)).toBe('c2');
  });

  test('越过与 c3 的中点就开始避让，与 closestCenter 一致', () => {
    const half = (CARD_HEIGHT + GAP) / 2;
    expect(overId('c1', 0, half + 10)).toBe('c3');
    expect(closestId('c1', 0, half + 10)).toBe('c3');
    expect(overId('c1', 0, half - 10)).toBe('c1');
  });

  test('拖回原位 → over 回到自己，兄弟归位', () => {
    expect(overId('c1', 0, CARD_HEIGHT + GAP)).toBe('c3');
    expect(overId('c1', 0, 0)).toBe('c1');
  });
});

describe('键盘拖拽（没有指针坐标）', () => {
  test('退回 closestCenter：远处也照样选最近的目标', () => {
    expect(overId('c1', 900, 0, false)).toBe('c2');
    expect(overId('c1', 0, 800, false)).toBe('c3');
  });

  test('近处结果与带指针时一致', () => {
    expect(overId('c1', 0, CARD_HEIGHT + GAP, false)).toBe('c3');
  });
});
