import { describe, expect, test } from 'bun:test';
import { measureElementRect, resolveInitialTerminalGrid } from './terminal-initial-grid';

describe('resolveInitialTerminalGrid', () => {
  test('按容器像素与字号估列数，宽终端不再落到 80 列', () => {
    const grid = resolveInitialTerminalGrid({
      rect: { width: 2400, height: 900 },
      fontSize: 14,
      lineHeight: 1.2,
    });
    expect(grid.cols).toBe(343);
    expect(grid.rows).toBe(54);
  });

  test('窄容器仍按 200 列建面：回滚字节预算按创建列数定档，估宽只是多留回滚', () => {
    const grid = resolveInitialTerminalGrid({
      rect: { width: 600, height: 200 },
      fontSize: 14,
      lineHeight: 1.2,
    });
    expect(grid.cols).toBe(200);
    expect(grid.rows).toBe(24);
  });

  test('测不到容器时退回宽默认值', () => {
    expect(resolveInitialTerminalGrid({ rect: null, fontSize: 14 })).toEqual({
      cols: 200,
      rows: 24,
    });
  });

  test('异常字号 / 行高不会算出非法网格', () => {
    expect(resolveInitialTerminalGrid({ rect: { width: 1000, height: 500 }, fontSize: 0 })).toEqual(
      { cols: 400, rows: 120 }
    );
    expect(
      resolveInitialTerminalGrid({
        rect: { width: Number.NaN, height: Number.NaN },
        fontSize: 14,
        lineHeight: 0,
      })
    ).toEqual({ cols: 200, rows: 24 });
  });

  test('超大容器被夹到上限', () => {
    const grid = resolveInitialTerminalGrid({
      rect: { width: 100_000, height: 100_000 },
      fontSize: 12,
    });
    expect(grid).toEqual({ cols: 400, rows: 120 });
  });
});

describe('measureElementRect', () => {
  test('零尺寸与缺席元素都返回 null', () => {
    expect(measureElementRect(null)).toBeNull();
    expect(
      measureElementRect({ getBoundingClientRect: () => ({ width: 0, height: 10 }) })
    ).toBeNull();
    expect(
      measureElementRect({ getBoundingClientRect: () => ({ width: 10, height: 0 }) })
    ).toBeNull();
  });

  test('可测量元素返回宽高', () => {
    expect(
      measureElementRect({ getBoundingClientRect: () => ({ width: 12.5, height: 7.5 }) })
    ).toEqual({ width: 12.5, height: 7.5 });
  });
});
