import { describe, expect, test } from 'bun:test';
import { unionSelectionViewportRect } from './selection-viewport-rect';

const CELL = { width: 10, height: 20 };
const SCREEN = { left: 100, top: 50 };

describe('unionSelectionViewportRect', () => {
  test('空选区或滚出视口时返回 null', () => {
    expect(unionSelectionViewportRect([], SCREEN, CELL)).toBeNull();
  });

  test('cell 尺寸非法时返回 null', () => {
    expect(
      unionSelectionViewportRect([{ row: 0, x: 0, width: 4 }], SCREEN, { width: 0, height: 20 })
    ).toBeNull();
    expect(
      unionSelectionViewportRect([{ row: 0, x: 0, width: 4 }], SCREEN, { width: 10, height: 0 })
    ).toBeNull();
  });

  test('单行选区按 cell 投影到 client 坐标', () => {
    expect(unionSelectionViewportRect([{ row: 2, x: 3, width: 5 }], SCREEN, CELL)).toEqual({
      left: 130,
      top: 90,
      width: 50,
      height: 20,
    });
  });

  test('多行选区取包围盒', () => {
    expect(
      unionSelectionViewportRect(
        [
          { row: 0, x: 4, width: 6 },
          { row: 1, x: 0, width: 13 },
          { row: 2, x: 0, width: 4 },
        ],
        SCREEN,
        CELL
      )
    ).toEqual({
      left: 100,
      top: 50,
      width: 130,
      height: 60,
    });
  });

  test('零宽矩形不参与并集；全部零宽则 null', () => {
    expect(
      unionSelectionViewportRect(
        [
          { row: 0, x: 2, width: 0 },
          { row: 1, x: 1, width: 3 },
        ],
        SCREEN,
        CELL
      )
    ).toEqual({
      left: 110,
      top: 70,
      width: 30,
      height: 20,
    });
    expect(unionSelectionViewportRect([{ row: 0, x: 2, width: 0 }], SCREEN, CELL)).toBeNull();
  });
});
