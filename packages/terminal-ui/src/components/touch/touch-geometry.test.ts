import { describe, expect, test } from 'bun:test';
import {
  FALLBACK_CELL_HEIGHT_PX,
  LONG_PRESS_MOVE_TOLERANCE_PX,
  TOUCH_SCROLL_GAIN,
  type TouchPoint,
  type TouchPointList,
  accumulateScrollPixels,
  exceedsMoveTolerance,
  findTouchById,
  isInsideRect,
  isInsideRightEdgeHotzone,
  isMobileTouchEnvironment,
  movedDistance,
  pendingPixelsToLines,
  terminalLineHeight,
  touchCentroidY,
} from './touch-geometry';

function point(identifier: number, clientX: number, clientY: number): TouchPoint {
  return { identifier, clientX, clientY };
}

function touchList(...points: (TouchPoint | null)[]): TouchPointList {
  return {
    length: points.length,
    item: (index) => points[index] ?? null,
  };
}

describe('isMobileTouchEnvironment', () => {
  test('narrow viewport counts as mobile', () => {
    expect(isMobileTouchEnvironment({ innerWidth: 767, navigator: { maxTouchPoints: 0 } })).toBe(
      true
    );
  });

  test('wide viewport with a touch digitizer counts as mobile', () => {
    expect(isMobileTouchEnvironment({ innerWidth: 1920, navigator: { maxTouchPoints: 5 } })).toBe(
      true
    );
  });

  test('an ontouchstart property counts as mobile', () => {
    const view = { innerWidth: 1920, navigator: { maxTouchPoints: 0 }, ontouchstart: null };
    expect(isMobileTouchEnvironment(view)).toBe(true);
  });

  test('wide pointer-only viewport is not mobile', () => {
    expect(isMobileTouchEnvironment({ innerWidth: 768, navigator: { maxTouchPoints: 0 } })).toBe(
      false
    );
  });
});

describe('findTouchById', () => {
  test('returns null when no touch is tracked', () => {
    expect(findTouchById(touchList(point(1, 10, 10)), null)).toBeNull();
  });

  test('finds the tracked identifier regardless of position', () => {
    const tracked = point(7, 30, 40);
    expect(findTouchById(touchList(point(1, 0, 0), tracked), 7)).toBe(tracked);
  });

  test('returns null when the identifier is gone', () => {
    expect(findTouchById(touchList(point(1, 0, 0)), 7)).toBeNull();
  });

  test('skips holes in the list', () => {
    const tracked = point(7, 30, 40);
    expect(findTouchById(touchList(null, tracked), 7)).toBe(tracked);
  });
});

describe('touchCentroidY', () => {
  test('empty list has no centroid', () => {
    expect(touchCentroidY(touchList())).toBe(0);
  });

  test('averages only the present touches', () => {
    expect(touchCentroidY(touchList(point(1, 0, 100), null, point(2, 0, 200)))).toBe(150);
  });
});

describe('movedDistance / exceedsMoveTolerance', () => {
  test('measures euclidean distance from the anchor', () => {
    expect(movedDistance(0, 0, 3, 4)).toBe(5);
  });

  test('the tolerance boundary itself does not exceed', () => {
    expect(exceedsMoveTolerance(0, 0, LONG_PRESS_MOVE_TOLERANCE_PX, 0)).toBe(false);
    expect(exceedsMoveTolerance(0, 0, LONG_PRESS_MOVE_TOLERANCE_PX + 0.01, 0)).toBe(true);
  });

  test('accepts an explicit tolerance', () => {
    expect(exceedsMoveTolerance(0, 0, 3, 4, 5)).toBe(false);
    expect(exceedsMoveTolerance(0, 0, 3, 4, 4.9)).toBe(true);
  });
});

describe('terminalLineHeight', () => {
  test('reads the renderer css cell height', () => {
    const terminal = {
      _core: { _renderService: { dimensions: { css: { cell: { height: 21 } } } } },
    };
    expect(terminalLineHeight(terminal)).toBe(21);
  });

  test('falls back when the renderer is not ready', () => {
    expect(terminalLineHeight(null)).toBe(FALLBACK_CELL_HEIGHT_PX);
    expect(terminalLineHeight({})).toBe(FALLBACK_CELL_HEIGHT_PX);
    expect(terminalLineHeight({ _core: { _renderService: {} } })).toBe(FALLBACK_CELL_HEIGHT_PX);
  });
});

describe('scroll accumulation', () => {
  test('applies the touch gain to the raw pixel delta', () => {
    expect(accumulateScrollPixels(0, 10)).toBe(10 * TOUCH_SCROLL_GAIN);
    expect(accumulateScrollPixels(5, -10)).toBe(5 - 10 * TOUCH_SCROLL_GAIN);
  });

  test('converts to whole lines toward zero', () => {
    expect(pendingPixelsToLines(39, 20)).toBe(1);
    expect(pendingPixelsToLines(-39, 20)).toBe(-1);
    expect(pendingPixelsToLines(19, 20)).toBe(0);
    // Math.ceil 对 (-1, 0) 返回 -0：调用方的 `=== 0` 守卫仍成立
    expect(pendingPixelsToLines(-19, 20)).toBe(-0);
    expect(pendingPixelsToLines(-19, 20) === 0).toBe(true);
  });

  test('sub-line motion accumulates until a whole line is reached', () => {
    let pending = 0;
    const lineHeight = 20;
    const consumed: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      pending = accumulateScrollPixels(pending, 6);
      const lines = pendingPixelsToLines(pending, lineHeight);
      if (lines !== 0) {
        consumed.push(lines);
        pending -= lines * lineHeight;
      }
    }
    expect(consumed).toEqual([1]);
    expect(pending).toBeCloseTo(3.4, 10);
  });
});

describe('hot zone geometry', () => {
  const rect = { left: 100, right: 300, top: 50, bottom: 250 };

  test('rect edges are inclusive', () => {
    expect(isInsideRect(rect, 100, 50)).toBe(true);
    expect(isInsideRect(rect, 300, 250)).toBe(true);
    expect(isInsideRect(rect, 99, 100)).toBe(false);
    expect(isInsideRect(rect, 200, 251)).toBe(false);
  });

  test('only the right edge band is a hot zone', () => {
    expect(isInsideRightEdgeHotzone(rect, 299, 100, 36)).toBe(true);
    expect(isInsideRightEdgeHotzone(rect, 264, 100, 36)).toBe(true);
    expect(isInsideRightEdgeHotzone(rect, 263, 100, 36)).toBe(false);
  });

  test('points outside the rect are never in the hot zone', () => {
    expect(isInsideRightEdgeHotzone(rect, 299, 20, 36)).toBe(false);
    expect(isInsideRightEdgeHotzone(rect, 301, 100, 36)).toBe(false);
  });
});
