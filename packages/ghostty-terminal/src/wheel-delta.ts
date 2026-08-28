export const WHEEL_DELTA_MODE_PIXEL = 0;
export const WHEEL_DELTA_MODE_LINE = 1;
export const WHEEL_DELTA_MODE_PAGE = 2;

export type WheelAccumulator = { pixels: number };

export type ConsumeWheelDeltaInput = {
  delta: number;
  cellSize: number;
  deltaMode: number | undefined;
  viewportUnits: number;
  accumulator: WheelAccumulator;
};

export function createWheelAccumulator(): WheelAccumulator {
  return { pixels: 0 };
}

export function roundAwayFromZero(value: number): number {
  return value > 0 ? Math.ceil(value) : Math.floor(value);
}

function truncateTowardZero(value: number): number {
  return value > 0 ? Math.floor(value) : Math.ceil(value);
}

// 三种 deltaMode 统一换算成「格数」：行/页模式是整格语义，直接向外取整并丢弃像素余量；
// 像素模式按 cellSize 累积，只消费整格、余量留给下一次事件，避免高分辨率触控板半格丢失。
export function consumeWheelDelta(input: ConsumeWheelDeltaInput): number {
  const { delta, cellSize, deltaMode, viewportUnits, accumulator } = input;

  if (deltaMode === WHEEL_DELTA_MODE_LINE) {
    accumulator.pixels = 0;
    return roundAwayFromZero(delta);
  }

  if (deltaMode === WHEEL_DELTA_MODE_PAGE) {
    accumulator.pixels = 0;
    return roundAwayFromZero(delta * Math.max(1, viewportUnits));
  }

  accumulator.pixels += delta;
  const units = truncateTowardZero(accumulator.pixels / cellSize);
  if (units !== 0) {
    accumulator.pixels -= units * cellSize;
  }
  return units;
}
