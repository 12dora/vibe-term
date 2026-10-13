// 回流过渡的纯计算部分：位移怎么算、主题时长怎么读。真正播动画的部分依赖 DOM，由实机覆盖。

import { describe, expect, test } from 'bun:test';
import { flipDelta, layoutPoint, parseCssTimeMs } from './flip';

describe('flipDelta', () => {
  test('从旧位置滑到新位置：位移 = 旧 − 新', () => {
    expect(flipDelta({ x: 0, y: 0 }, { x: 300, y: 0 })).toEqual({ x: -300, y: 0 });
    // 换行：往左回到行首、往下一行
    expect(flipDelta({ x: 600, y: 0 }, { x: 0, y: 140 })).toEqual({ x: 600, y: -140 });
  });

  test('新出现的条目（没有旧位置）不播', () => {
    expect(flipDelta(undefined, { x: 300, y: 0 })).toBeNull();
  });

  test('没动 / 亚像素抖动不播', () => {
    expect(flipDelta({ x: 10, y: 20 }, { x: 10, y: 20 })).toBeNull();
    expect(flipDelta({ x: 10, y: 20 }, { x: 10.3, y: 19.8 })).toBeNull();
    const nudged = flipDelta({ x: 10, y: 20 }, { x: 11, y: 20 });
    expect(nudged).toEqual({ x: -1, y: 0 });
  });

  test('上一段动画还在飞：从此刻看到的位置接着走', () => {
    // 记录的旧位置是 x=300，但条目正从 x=0 滑过来、还差 120 没走完（看到的是 x=180）；
    // 这时又被挪到 x=600：应该从 180 滑到 600，而不是从 300 跳一下再滑
    expect(flipDelta({ x: 300, y: 0 }, { x: 600, y: 0 }, { x: -120, y: 0 })).toEqual({
      x: -420,
      y: 0,
    });
  });

  test('在飞的位移刚好把条目送回新位置：不播', () => {
    expect(flipDelta({ x: 300, y: 0 }, { x: 0, y: 0 }, { x: -300, y: 0 })).toBeNull();
  });
});

describe('layoutPoint（布局位置，不含 transform）', () => {
  const measurable = (
    offset: { left: number; top: number },
    rect: { left: number; top: number },
    offsetParent: unknown = null
  ) => ({
    offsetLeft: offset.left,
    offsetTop: offset.top,
    offsetParent,
    getBoundingClientRect: () => rect,
  });

  test('网格是条目的 offsetParent：直接用 offset，带着位移的可见矩形不影响结果', () => {
    const grid = measurable({ left: 0, top: 0 }, { left: 40, top: 500 });
    // 条目正被 sortable / 在飞的过渡平移了 (+300, -80)：可见矩形变了，布局位置没变
    const shifted = measurable({ left: 418, top: 212 }, { left: 758, top: 632 }, grid);
    expect(layoutPoint(shifted, grid)).toEqual({ x: 418, y: 212 });
  });

  test('offsetParent 不是网格（样式被改过）：退回可见矩形之差', () => {
    const grid = measurable({ left: 0, top: 0 }, { left: 40, top: 500 });
    const item = measurable({ left: 999, top: 999 }, { left: 458, top: 712 }, {});
    expect(layoutPoint(item, grid)).toEqual({ x: 418, y: 212 });
  });

  test('键盘取消的那种情形：条目带着内联位移，前后两次量到的布局位置相同 → 不播', () => {
    const grid = measurable({ left: 0, top: 0 }, { left: 0, top: 0 });
    const offset = { left: 418, top: 0 };
    const atStart = layoutPoint(measurable(offset, { left: 418, top: 0 }, grid), grid);
    const displaced = layoutPoint(measurable(offset, { left: 0, top: 0 }, grid), grid);
    expect(flipDelta(atStart, displaced)).toBeNull();
  });
});

describe('parseCssTimeMs', () => {
  test('毫秒与秒都认，前后空白不影响', () => {
    expect(parseCssTimeMs('200ms', 1)).toBe(200);
    expect(parseCssTimeMs(' 0.2s ', 1)).toBe(200);
    expect(parseCssTimeMs('.15s', 1)).toBe(150);
    expect(parseCssTimeMs('0ms', 1)).toBe(0);
  });

  test('读不出来 / 负数用 fallback', () => {
    expect(parseCssTimeMs('', 200)).toBe(200);
    expect(parseCssTimeMs('fast', 200)).toBe(200);
    expect(parseCssTimeMs('200', 200)).toBe(200);
    expect(parseCssTimeMs('-50ms', 200)).toBe(200);
  });
});
