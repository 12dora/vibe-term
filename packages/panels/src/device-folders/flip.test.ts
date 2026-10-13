// 回流过渡的纯计算部分：位移怎么算、主题时长怎么读。真正播动画的部分依赖 DOM，由实机覆盖。

import { describe, expect, test } from 'bun:test';
import { flipDelta, parseCssTimeMs } from './flip';

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
