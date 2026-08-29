// 块元素自绘的全码位几何基线：U+2580–U+259F 每个码位的 fillRect 序列都写死在期望表里，
// 任何 1/8 分割、shade alpha、象限位序的漂移都会被这里挡下。
import { describe, expect, test } from 'bun:test';
import { blockElementCodepoint, drawBlockElement, isBlockElement } from './block-elements';

type Rect = [x: number, y: number, width: number, height: number];

type FillOp = {
  rect: Rect;
  alpha: number;
};

class FakeCtx {
  globalAlpha = 1;
  ops: FillOp[] = [];
  fillRect(x: number, y: number, width: number, height: number): void {
    this.ops.push({ rect: [x, y, width, height], alpha: this.globalAlpha });
  }
}

const GEOMETRY = { x: 100, y: 200, width: 10, height: 20 };

function paint(codepoint: number, baseAlpha = 1): FakeCtx {
  const context = new FakeCtx();
  context.globalAlpha = baseAlpha;
  drawBlockElement(context, codepoint, GEOMETRY);
  return context;
}

function rectsOf(codepoint: number): Rect[] {
  return paint(codepoint).ops.map((op) => op.rect);
}

// cell 左上角 (100,200)，10×20 物理像素：1/8 分割点按 Math.round 落到整数像素。
const UL: Rect = [100, 200, 5, 10];
const UR: Rect = [105, 200, 5, 10];
const LL: Rect = [100, 210, 5, 10];
const LR: Rect = [105, 210, 5, 10];
const FULL: Rect = [100, 200, 10, 20];

const EXPECTED_RECTS = new Map<number, Rect[]>([
  [0x2580, [[100, 200, 10, 10]]],
  [0x2581, [[100, 218, 10, 2]]],
  [0x2582, [[100, 215, 10, 5]]],
  [0x2583, [[100, 213, 10, 7]]],
  [0x2584, [[100, 210, 10, 10]]],
  [0x2585, [[100, 208, 10, 12]]],
  [0x2586, [[100, 205, 10, 15]]],
  [0x2587, [[100, 203, 10, 17]]],
  [0x2588, [FULL]],
  [0x2589, [[100, 200, 9, 20]]],
  [0x258a, [[100, 200, 8, 20]]],
  [0x258b, [[100, 200, 6, 20]]],
  [0x258c, [[100, 200, 5, 20]]],
  [0x258d, [[100, 200, 4, 20]]],
  [0x258e, [[100, 200, 3, 20]]],
  [0x258f, [[100, 200, 1, 20]]],
  [0x2590, [[105, 200, 5, 20]]],
  [0x2591, [FULL]],
  [0x2592, [FULL]],
  [0x2593, [FULL]],
  [0x2594, [[100, 200, 10, 3]]],
  [0x2595, [[109, 200, 1, 20]]],
  [0x2596, [LL]],
  [0x2597, [LR]],
  [0x2598, [UL]],
  [0x2599, [UL, LL, LR]],
  [0x259a, [UL, LR]],
  [0x259b, [UL, UR, LL]],
  [0x259c, [UL, UR, LR]],
  [0x259d, [UR]],
  [0x259e, [UR, LL]],
  [0x259f, [UR, LL, LR]],
]);

describe('drawBlockElement', () => {
  test('覆盖 U+2580–U+259F 全码位，逐个码位几何与期望表一致', () => {
    for (let codepoint = 0x2580; codepoint <= 0x259f; codepoint += 1) {
      const expected = EXPECTED_RECTS.get(codepoint);
      expect(expected).toBeDefined();
      expect({ codepoint, rects: rectsOf(codepoint) }).toEqual({
        codepoint,
        rects: expected ?? [],
      });
    }
  });

  test('░▒▓ 按 0.25/0.5/0.75 与当前 alpha 相乘，画完还原', () => {
    for (const [codepoint, shade] of [
      [0x2591, 0.25],
      [0x2592, 0.5],
      [0x2593, 0.75],
    ] as const) {
      const context = paint(codepoint, 0.5);
      expect(context.ops).toHaveLength(1);
      expect(context.ops[0]?.alpha).toBeCloseTo(0.5 * shade, 10);
      expect(context.globalAlpha).toBe(0.5);
    }
  });

  test('非 shade 码位不改动 alpha', () => {
    const context = paint(0x2588, 0.4);
    expect(context.ops[0]?.alpha).toBe(0.4);
    expect(context.globalAlpha).toBe(0.4);
  });

  test('未登记码位为 no-op', () => {
    for (const codepoint of [0x0041, 0x257f, 0x25a0, 0x2500, 0x1f600]) {
      expect(paint(codepoint).ops).toEqual([]);
    }
  });
});

describe('isBlockElement', () => {
  test('恰好覆盖 U+2580–U+259F', () => {
    for (let codepoint = 0x257d; codepoint <= 0x25a3; codepoint += 1) {
      expect({ codepoint, block: isBlockElement(codepoint) }).toEqual({
        codepoint,
        block: codepoint >= 0x2580 && codepoint <= 0x259f,
      });
    }
  });
});

describe('blockElementCodepoint', () => {
  test('仅单码位块元素被识别', () => {
    expect(blockElementCodepoint([0x2588])).toBe(0x2588);
    expect(blockElementCodepoint([0x0041])).toBeNull();
    expect(blockElementCodepoint([0x2588, 0x0301])).toBeNull();
    expect(blockElementCodepoint([])).toBeNull();
  });
});
