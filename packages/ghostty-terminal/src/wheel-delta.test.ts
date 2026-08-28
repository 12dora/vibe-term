// consumeWheelDelta 是从 TerminalInputBridge.gestureToLines / gestureToColumns 里抽出来的，
// 这里同时保留一份「抽取前」的参考实现做等价性对拍（characterization），
// 保证重构没有改变任何一种 deltaMode 下的取整、符号与余量行为。
import { describe, expect, test } from 'bun:test';
import {
  WHEEL_DELTA_MODE_LINE,
  WHEEL_DELTA_MODE_PAGE,
  WHEEL_DELTA_MODE_PIXEL,
  type WheelAccumulator,
  consumeWheelDelta,
  createWheelAccumulator,
  roundAwayFromZero,
} from './wheel-delta';

type LegacyState = { remainder: number };

function legacyConsume(
  delta: number,
  cellSize: number,
  deltaMode: number | undefined,
  viewportUnits: number,
  state: LegacyState
): number {
  if (deltaMode === 1) {
    state.remainder = 0;
    return delta > 0 ? Math.ceil(delta) : Math.floor(delta);
  }

  if (deltaMode === 2) {
    state.remainder = 0;
    const scaled = delta * Math.max(1, viewportUnits);
    return scaled > 0 ? Math.ceil(scaled) : Math.floor(scaled);
  }

  state.remainder += delta;
  const units =
    state.remainder > 0
      ? Math.floor(state.remainder / cellSize)
      : Math.ceil(state.remainder / cellSize);
  if (units !== 0) {
    state.remainder -= units * cellSize;
  }
  return units;
}

function consume(
  accumulator: WheelAccumulator,
  delta: number,
  deltaMode: number | undefined = WHEEL_DELTA_MODE_PIXEL,
  cellSize = 16,
  viewportUnits = 24
): number {
  return consumeWheelDelta({ delta, cellSize, deltaMode, viewportUnits, accumulator });
}

describe('roundAwayFromZero', () => {
  test('正负与零分别向外取整', () => {
    expect(roundAwayFromZero(0.1)).toBe(1);
    expect(roundAwayFromZero(-0.1)).toBe(-1);
    expect(roundAwayFromZero(0)).toBe(0);
    expect(roundAwayFromZero(-3)).toBe(-3);
  });
});

describe('consumeWheelDelta 像素模式', () => {
  test('不足一格时累积、不产出', () => {
    const accumulator = createWheelAccumulator();

    expect(consume(accumulator, 6)).toBe(0);
    expect(consume(accumulator, 6)).toBe(0);
    expect(accumulator.pixels).toBe(12);
    expect(consume(accumulator, 6)).toBe(1);
    expect(accumulator.pixels).toBe(2);
  });

  test('余量在下一次事件中继续参与换算', () => {
    const accumulator = createWheelAccumulator();

    expect(consume(accumulator, 20)).toBe(1);
    expect(accumulator.pixels).toBe(4);
    expect(consume(accumulator, 12)).toBe(1);
    expect(accumulator.pixels).toBe(0);
  });

  test('负方向按向零取整，余量为负', () => {
    const accumulator = createWheelAccumulator();

    expect(consume(accumulator, -20)).toBe(-1);
    expect(accumulator.pixels).toBe(-4);
    // 向零取整在负半轴会产出 -0，与抽取前一致；调用方只做 === 0 / Math.abs 判断，不受影响
    expect(consume(accumulator, -6)).toBe(-0);
    expect(accumulator.pixels).toBe(-10);
    expect(consume(accumulator, -6)).toBe(-1);
  });

  test('方向反转时余量先被抵消', () => {
    const accumulator = createWheelAccumulator();

    expect(consume(accumulator, 12)).toBe(0);
    expect(consume(accumulator, -12)).toBe(0);
    expect(accumulator.pixels).toBe(0);
  });

  test('单次大位移一次产出多格', () => {
    const accumulator = createWheelAccumulator();

    expect(consume(accumulator, 100)).toBe(6);
    expect(accumulator.pixels).toBe(4);
  });

  test('非整数 cell 尺寸下余量仍精确', () => {
    const accumulator = createWheelAccumulator();

    expect(consume(accumulator, 20, WHEEL_DELTA_MODE_PIXEL, 15.5)).toBe(1);
    expect(accumulator.pixels).toBeCloseTo(4.5, 10);
  });

  test('deltaMode 缺省时按像素模式处理', () => {
    const accumulator = createWheelAccumulator();

    expect(consume(accumulator, 20, undefined)).toBe(1);
    expect(accumulator.pixels).toBe(4);
  });
});

describe('consumeWheelDelta 行 / 页模式', () => {
  test('行模式直接向外取整且清空像素余量', () => {
    const accumulator = createWheelAccumulator();

    consume(accumulator, 12);
    expect(accumulator.pixels).toBe(12);
    expect(consume(accumulator, 3, WHEEL_DELTA_MODE_LINE)).toBe(3);
    expect(accumulator.pixels).toBe(0);
    expect(consume(accumulator, -0.5, WHEEL_DELTA_MODE_LINE)).toBe(-1);
  });

  test('页模式按视口尺寸放大后向外取整', () => {
    const accumulator = createWheelAccumulator();

    consume(accumulator, 12);
    expect(consume(accumulator, 1, WHEEL_DELTA_MODE_PAGE)).toBe(24);
    expect(accumulator.pixels).toBe(0);
    expect(consume(accumulator, -0.5, WHEEL_DELTA_MODE_PAGE)).toBe(-12);
  });

  test('视口尺寸为 0 时按 1 兜底', () => {
    const accumulator = createWheelAccumulator();

    expect(consume(accumulator, 2, WHEEL_DELTA_MODE_PAGE, 16, 0)).toBe(2);
  });
});

describe('consumeWheelDelta 与抽取前实现等价', () => {
  test('混合序列逐步对拍', () => {
    const accumulator = createWheelAccumulator();
    const legacy: LegacyState = { remainder: 0 };
    const steps: Array<[number, number | undefined]> = [
      [6, 0],
      [6, 0],
      [6, 0],
      [-3, 0],
      [-20, 0],
      [2, WHEEL_DELTA_MODE_LINE],
      [7, 0],
      [-0.5, WHEEL_DELTA_MODE_PAGE],
      [9, undefined],
      [100, 0],
      [-100, 0],
      [0, 0],
      [15.5, 0],
      [-1.25, WHEEL_DELTA_MODE_LINE],
    ];

    for (const [delta, deltaMode] of steps) {
      const actual = consumeWheelDelta({
        delta,
        cellSize: 16,
        deltaMode,
        viewportUnits: 24,
        accumulator,
      });
      expect(actual).toBe(legacyConsume(delta, 16, deltaMode, 24, legacy));
      expect(accumulator.pixels).toBeCloseTo(legacy.remainder, 10);
    }
  });
});
