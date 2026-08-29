import { describe, expect, test } from 'bun:test';
import { snapToCursorTransform } from './snap-to-cursor';

const TRANSFORM = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

describe('snapToCursorTransform', () => {
  test('把 overlay 的中心吸到按下点上', () => {
    // overlay 摆在 (100,50)、尺寸 200×40；按下点在它左上角附近的把手上
    const next = snapToCursorTransform(
      TRANSFORM,
      { left: 100, top: 50, width: 200, height: 40 },
      { x: 110, y: 60 }
    );
    // 中心要落到 (110,60)：x 补 (110-100) - 100，y 补 (60-50) - 20
    expect(next).toEqual({ x: -90, y: -10, scaleX: 1, scaleY: 1 });
  });

  test('保留已有位移（拖动过程中的跟手量）与缩放', () => {
    const next = snapToCursorTransform(
      { x: 30, y: -12, scaleX: 1, scaleY: 1 },
      { left: 0, top: 0, width: 100, height: 20 },
      { x: 10, y: 5 }
    );
    expect(next).toEqual({ x: 30 + 10 - 50, y: -12 + 5 - 10, scaleX: 1, scaleY: 1 });
  });

  test('缺矩形或缺按下点时原样返回（键盘拖拽没有指针坐标）', () => {
    expect(snapToCursorTransform(TRANSFORM, null, { x: 1, y: 1 })).toBe(TRANSFORM);
    expect(snapToCursorTransform(TRANSFORM, { left: 0, top: 0, width: 10, height: 10 }, null)).toBe(
      TRANSFORM
    );
  });
});
