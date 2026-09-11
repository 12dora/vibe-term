import { describe, expect, test } from 'bun:test';
import {
  POPOVER_GAP,
  POPOVER_MAX_WIDTH,
  POPOVER_MIN_BELOW,
  type PopoverAnchorRect,
  clampPopoverOffset,
  placePopover,
  popoverWidth,
} from './popover-clamp';

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

/** iPhone 14 竖屏页头里的徽标：页头在安全区之下，徽标靠右。 */
function badge(overrides: Partial<PopoverAnchorRect> = {}): PopoverAnchorRect {
  return { left: 330, right: 382, top: 60, bottom: 76, ...overrides };
}

describe('placePopover 横向', () => {
  test('手机上右对齐会出屏时推回来，两侧都留出边距', () => {
    const box = placePopover({ anchor: badge(), viewport: { width: 390, height: 844 } });
    expect(box.left).toBeGreaterThanOrEqual(MARGIN);
    expect(box.left + box.width).toBeLessThanOrEqual(390 - MARGIN);
    expect(box.width).toBe(POPOVER_MAX_WIDTH);
  });

  test('桌面视口放得下就保持贴徽标右对齐', () => {
    const box = placePopover({
      anchor: badge({ left: 980, right: 1032 }),
      viewport: { width: 1280, height: 800 },
    });
    expect(box.left + box.width).toBe(1032);
  });

  test('视觉视口有横向偏移（双指缩放）时按可见那块夹', () => {
    const box = placePopover({
      anchor: badge({ left: 300, right: 352 }),
      viewport: { width: 200, height: 400, offsetLeft: 200, offsetTop: 100 },
    });
    expect(box.left).toBeGreaterThanOrEqual(200 + MARGIN);
    expect(box.left + box.width).toBeLessThanOrEqual(400 - MARGIN);
  });
});

describe('placePopover 纵向', () => {
  test('下方够高：贴着徽标下沿展开，最大高度就是剩下那段', () => {
    const box = placePopover({ anchor: badge(), viewport: { width: 390, height: 844 } });
    expect(box.above).toBe(false);
    expect(box.top).toBe(76 + POPOVER_GAP);
    expect(box.bottom).toBeNull();
    expect(box.maxHeight).toBe(844 - MARGIN - (76 + POPOVER_GAP));
  });

  test('横屏下方不足 200px：卡片高度收到剩余空间，不越过视口底', () => {
    const box = placePopover({
      anchor: badge({ top: 40, bottom: 56 }),
      viewport: { width: 844, height: 390 },
    });
    const bottomEdge = (box.top ?? 0) + box.maxHeight;
    expect(bottomEdge).toBeLessThanOrEqual(390 - MARGIN);
    expect(box.maxHeight).toBeGreaterThan(0);
  });

  test('徽标贴近屏底且上方更宽敞时翻到上面，用 bottom 贴住徽标上沿', () => {
    const box = placePopover({
      anchor: badge({ top: 700, bottom: 716 }),
      viewport: { width: 390, height: 800, layoutHeight: 800 },
    });
    expect(box.above).toBe(true);
    expect(box.top).toBeNull();
    expect(box.bottom).toBe(800 - (700 - POPOVER_GAP));
    expect(box.maxHeight).toBe(700 - POPOVER_GAP - MARGIN);
  });

  test('上方同样局促时不翻：宁可向下滚，也不把卡片塞到更小的一侧', () => {
    const box = placePopover({
      anchor: badge({ top: 100, bottom: 116 }),
      viewport: { width: 390, height: 260 },
    });
    expect(box.above).toBe(false);
    expect(box.maxHeight).toBeLessThan(POPOVER_MIN_BELOW);
  });

  test('翻到上方时不压住状态栏（安全区）', () => {
    const box = placePopover({
      anchor: badge({ top: 700, bottom: 716 }),
      viewport: { width: 390, height: 800, layoutHeight: 800 },
      safeTop: 59,
    });
    const topEdge = 800 - (box.bottom ?? 0) - box.maxHeight;
    expect(topEdge).toBeGreaterThanOrEqual(59);
  });

  test('键盘弹起（视觉视口上移且变矮）时仍夹在可见那块里', () => {
    const box = placePopover({
      anchor: badge({ top: 300, bottom: 316 }),
      viewport: { width: 390, height: 400, offsetTop: 150, layoutHeight: 844 },
    });
    expect((box.top ?? 0) + box.maxHeight).toBeLessThanOrEqual(150 + 400 - MARGIN);
    expect(box.top).toBeGreaterThanOrEqual(150 + MARGIN);
  });
});
