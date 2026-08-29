import { describe, expect, test } from 'bun:test';
import { GestureDeltaAccumulator } from './gesture-delta-accumulator';

const CELL = 17;
const PAGE = 24;

function touch(delta: number): {
  source: 'touch';
  delta: number;
  cellSize: number;
  pageSize: number;
} {
  return { source: 'touch', delta, cellSize: CELL, pageSize: PAGE };
}

function wheel(
  delta: number,
  deltaMode: number
): { source: 'wheel'; delta: number; deltaMode: number; cellSize: number; pageSize: number } {
  return { source: 'wheel', delta, deltaMode, cellSize: CELL, pageSize: PAGE };
}

describe('gesture delta accumulator', () => {
  test('zero delta consumes nothing and keeps the pixel remainder', () => {
    const accumulator = new GestureDeltaAccumulator();

    expect(accumulator.consume(wheel(0, 0))).toBe(0);
    expect(accumulator.consume(wheel(10, 0))).toBe(0);
    expect(accumulator.consume(wheel(0, 1))).toBe(0);
    expect(accumulator.consume(wheel(0, 2))).toBe(0);
    // 余量未被清掉：再补 7px 正好凑满一个 cell
    expect(accumulator.consume(wheel(7, 0))).toBe(1);
  });

  test('non-wheel sources round away from zero by cell size', () => {
    const accumulator = new GestureDeltaAccumulator();

    expect(accumulator.consume(touch(1))).toBe(1);
    expect(accumulator.consume(touch(CELL))).toBe(1);
    expect(accumulator.consume(touch(CELL + 1))).toBe(2);
    expect(accumulator.consume(touch(-1))).toBe(-1);
    expect(accumulator.consume(touch(-CELL - 1))).toBe(-2);
  });

  test('non-wheel sources never touch the pixel remainder', () => {
    const accumulator = new GestureDeltaAccumulator();

    expect(accumulator.consume(wheel(10, 0))).toBe(0);
    expect(accumulator.consume(touch(3))).toBe(1);
    expect(accumulator.consume(wheel(7, 0))).toBe(1);
  });

  test('line mode rounds the raw delta and clears the pixel remainder', () => {
    const accumulator = new GestureDeltaAccumulator();

    expect(accumulator.consume(wheel(10, 0))).toBe(0);
    expect(accumulator.consume(wheel(0.5, 1))).toBe(1);
    expect(accumulator.consume(wheel(-2.5, 1))).toBe(-3);
    expect(accumulator.consume(wheel(7, 0))).toBe(0);
  });

  test('page mode scales by the viewport page size and clears the pixel remainder', () => {
    const accumulator = new GestureDeltaAccumulator();

    expect(accumulator.consume(wheel(10, 0))).toBe(0);
    expect(accumulator.consume(wheel(1, 2))).toBe(PAGE);
    expect(accumulator.consume(wheel(-0.5, 2))).toBe(-12);
    expect(accumulator.consume(wheel(7, 0))).toBe(0);
  });

  test('page mode treats a non-positive page size as one line', () => {
    const accumulator = new GestureDeltaAccumulator();

    expect(
      accumulator.consume({ source: 'wheel', delta: -3, deltaMode: 2, cellSize: CELL, pageSize: 0 })
    ).toBe(-3);
  });

  test('pixel mode carries the sub-cell remainder across gestures', () => {
    const accumulator = new GestureDeltaAccumulator();

    expect(accumulator.consume(wheel(9, 0))).toBe(0);
    expect(accumulator.consume(wheel(9, 0))).toBe(1);
    expect(accumulator.consume(wheel(16, 0))).toBe(1);
    expect(accumulator.consume(wheel(CELL * 3, 0))).toBe(3);
  });

  test('pixel mode keeps the remainder signed when the direction flips', () => {
    const accumulator = new GestureDeltaAccumulator();

    // 负向不足一格时向零取整得到 -0，与重构前的 Math.ceil 结果一致
    expect(accumulator.consume(wheel(-9, 0))).toBe(-0);
    expect(accumulator.consume(wheel(-9, 0))).toBe(-1);
    expect(accumulator.consume(wheel(10, 0))).toBe(0);
    expect(accumulator.consume(wheel(8, 0))).toBe(1);
  });

  test('reset drops the pending pixel remainder', () => {
    const accumulator = new GestureDeltaAccumulator();

    expect(accumulator.consume(wheel(16, 0))).toBe(0);
    accumulator.reset();
    expect(accumulator.consume(wheel(16, 0))).toBe(0);
    expect(accumulator.consume(wheel(1, 0))).toBe(1);
  });

  test('missing deltaMode falls back to pixel accumulation', () => {
    const accumulator = new GestureDeltaAccumulator();

    expect(accumulator.consume({ source: 'wheel', delta: 9, cellSize: CELL, pageSize: PAGE })).toBe(
      0
    );
    expect(accumulator.consume({ source: 'wheel', delta: 9, cellSize: CELL, pageSize: PAGE })).toBe(
      1
    );
  });
});
