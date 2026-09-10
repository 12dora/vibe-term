import { describe, expect, test } from 'bun:test';
import { POPOVER_MAX_WIDTH, clampPopoverOffset, popoverWidth } from './popover-clamp';

const MARGIN = 8;

/** 偏移换算回浮层在视口里的左右边界，断言直接照着「有没有出屏」写。 */
function edges(anchorRight: number, viewportWidth: number) {
  const width = popoverWidth(viewportWidth);
  const offset = clampPopoverOffset({ anchorRight, viewportWidth, width });
  const right = anchorRight - offset;
  return { left: right - width, right, width, offset };
}

describe('popoverWidth', () => {
  test('视口够宽时用 288', () => {
    expect(popoverWidth(390)).toBe(POPOVER_MAX_WIDTH);
    expect(popoverWidth(320)).toBe(POPOVER_MAX_WIDTH);
  });

  test('视口比 288 + 两侧边距还窄时按边距收窄', () => {
    expect(popoverWidth(300)).toBe(284);
    expect(popoverWidth(280)).toBe(264);
  });
});

describe('clampPopoverOffset', () => {
  test('放得下就保持右对齐，偏移为 0', () => {
    const { offset, left, right } = edges(1032, 1280);
    expect(offset).toBe(0);
    expect(left).toBe(744);
    expect(right).toBe(1032);
  });

  test('左侧溢出时右移到左边缘刚好留出边距', () => {
    const { left, right, offset } = edges(214, 390);
    expect(offset).toBe(-82);
    expect(left).toBe(MARGIN);
    expect(right).toBe(296);
  });

  test('右侧溢出时左移到右边缘刚好留出边距', () => {
    const { left, right, offset } = edges(388, 390);
    expect(offset).toBe(6);
    expect(right).toBe(382);
    expect(left).toBe(94);
  });

  test('320 视口下两侧都不出屏', () => {
    const { left, right } = edges(194.6875, 320);
    expect(left).toBe(MARGIN);
    expect(right).toBe(296);
    expect(right).toBeLessThanOrEqual(320 - MARGIN);
  });

  test('视口比 288 还窄时按收窄后的宽度贴左边距', () => {
    const { left, right, width } = edges(200, 260);
    expect(width).toBe(244);
    expect(left).toBe(MARGIN);
    expect(right).toBe(252);
  });

  test('区间为空（宽度没收窄）时保左边缘', () => {
    const offset = clampPopoverOffset({ anchorRight: 200, viewportWidth: 260, width: 288 });
    expect(200 - offset - 288).toBe(MARGIN);
  });
});
