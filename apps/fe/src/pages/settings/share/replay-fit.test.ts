// 回放自适应字号的纯计算：只由（网格, 外框, 字体度量）决定，必须可复算、不振荡。

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_CELL_WIDTH_RATIO,
  REPLAY_FIT_MAX_FONT_SIZE,
  REPLAY_FIT_MIN_FONT_SIZE,
  type ReplayFitInput,
  cellWidthRatioFrom,
  computeReplayFitFontSize,
  replayFitCellSize,
  sameReplayFitGrid,
} from './replay-fit';

const METRICS = { cellWidthRatio: 0.6, lineHeight: 1.2, devicePixelRatio: 2 };

function input(over: Partial<ReplayFitInput>): ReplayFitInput {
  return {
    grid: { cols: 52, rows: 47 },
    frame: { width: 1120, height: 660 },
    metrics: METRICS,
    baseFontSize: 13,
    ...over,
  };
}

function fills(size: number, source: ReplayFitInput): { width: number; height: number } {
  const cell = replayFitCellSize(size, source.metrics);
  const grid = source.grid;
  if (!grid) throw new Error('grid required');
  return { width: grid.cols * cell.width, height: grid.rows * cell.height };
}

describe('replayFitCellSize', () => {
  test('cell 高恒为 字号 × 行高，宽按 advance 比例，两者对齐物理像素', () => {
    expect(replayFitCellSize(13, METRICS)).toEqual({ width: 8, height: 15.5 });
    expect(replayFitCellSize(20, { ...METRICS, devicePixelRatio: 1 })).toEqual({
      width: 12,
      height: 24,
    });
  });

  test('dpr 非法时按 1 处理，cell 不会小于 1 像素', () => {
    expect(
      replayFitCellSize(1, { cellWidthRatio: 0.01, lineHeight: 0.01, devicePixelRatio: 0 })
    ).toEqual({ width: 1, height: 1 });
  });
});

describe('computeReplayFitFontSize', () => {
  test('手机竖录像（52×47）受高度限制缩到刚好装下，整屏不再被裁', () => {
    const source = input({});
    const size = computeReplayFitFontSize(source);
    const box = fills(size, source);
    expect(box.height).toBeLessThanOrEqual(source.frame.height);
    expect(box.width).toBeLessThanOrEqual(source.frame.width);
    // 再放一档就该溢出，说明确实取到了最大可用字号
    const bigger = fills(size + 1, source);
    expect(bigger.width > source.frame.width - 2 || bigger.height > source.frame.height - 2).toBe(
      true
    );
  });

  test('常见 80×24 录像在宽外框里放大到远超设置字号', () => {
    const source = input({ grid: { cols: 80, rows: 24 } });
    const size = computeReplayFitFontSize(source);
    expect(size).toBeGreaterThan(source.baseFontSize);
    const box = fills(size, source);
    expect(box.width).toBeLessThanOrEqual(source.frame.width);
    expect(box.height).toBeLessThanOrEqual(source.frame.height);
  });

  test('宽录像在同一外框里被缩小，受宽度限制', () => {
    const source = input({ grid: { cols: 220, rows: 50 } });
    const size = computeReplayFitFontSize(source);
    expect(size).toBeLessThan(source.baseFontSize);
    expect(fills(size, source).width).toBeLessThanOrEqual(source.frame.width);
  });

  test('小到下限还塞不下就停在下限，交给平移视口', () => {
    const source = input({ grid: { cols: 400, rows: 200 }, frame: { width: 400, height: 200 } });
    expect(computeReplayFitFontSize(source)).toBe(REPLAY_FIT_MIN_FONT_SIZE);
  });

  test('极小网格配极大外框时封顶在上限', () => {
    const source = input({ grid: { cols: 2, rows: 2 }, frame: { width: 4000, height: 4000 } });
    expect(computeReplayFitFontSize(source)).toBe(REPLAY_FIT_MAX_FONT_SIZE);
  });

  test('没有网格 / 量不到外框 / 度量非法时用设置里的字号', () => {
    expect(computeReplayFitFontSize(input({ grid: null }))).toBe(13);
    expect(computeReplayFitFontSize(input({ frame: { width: 0, height: 0 } }))).toBe(13);
    expect(computeReplayFitFontSize(input({ grid: { cols: 0, rows: 24 } }))).toBe(13);
    expect(computeReplayFitFontSize(input({ metrics: { ...METRICS, cellWidthRatio: 0 } }))).toBe(
      13
    );
  });

  test('同样的入参永远给同一个字号，与上一次结果无关', () => {
    const source = input({ grid: { cols: 80, rows: 24 } });
    const first = computeReplayFitFontSize(source);
    expect(computeReplayFitFontSize(source)).toBe(first);
    expect(computeReplayFitFontSize({ ...source, baseFontSize: 40 })).toBe(first);
  });

  test('外框差一像素不会来回跳：结果随外框单调不减', () => {
    const grid = { cols: 52, rows: 47 };
    let previous = 0;
    for (let height = 200; height <= 1200; height += 1) {
      const size = computeReplayFitFontSize(input({ grid, frame: { width: 4000, height } }));
      expect(size).toBeGreaterThanOrEqual(previous);
      previous = size;
    }
  });

  test('取整后的 cell 也留得下两像素余量，不会把居中翻成平移', () => {
    for (let width = 300; width <= 1600; width += 7) {
      const source = input({ grid: { cols: 80, rows: 24 }, frame: { width, height: 4000 } });
      const size = computeReplayFitFontSize(source);
      if (size === REPLAY_FIT_MIN_FONT_SIZE) continue;
      expect(fills(size, source).width).toBeLessThanOrEqual(width - 2);
    }
  });
});

describe('cellWidthRatioFrom', () => {
  test('按探针宽度折算比例', () => {
    const ratio = cellWidthRatioFrom(
      { measure: (_stack, fontSize, text) => text.length * fontSize * 0.6 },
      'mono'
    );
    expect(ratio).toBeCloseTo(0.6, 10);
  });

  test('量不到 / 离谱的比例返回 null，由调用方退回默认值', () => {
    expect(cellWidthRatioFrom({ measure: () => 0 }, 'mono')).toBeNull();
    expect(cellWidthRatioFrom({ measure: () => Number.NaN }, 'mono')).toBeNull();
    expect(
      cellWidthRatioFrom({ measure: (_s, size, text) => text.length * size * 3 }, 'x')
    ).toBeNull();
    expect(DEFAULT_CELL_WIDTH_RATIO).toBeGreaterThan(0);
  });
});

describe('sameReplayFitGrid', () => {
  test('按行列比较，null 只等于 null', () => {
    expect(sameReplayFitGrid({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(true);
    expect(sameReplayFitGrid({ cols: 80, rows: 24 }, { cols: 80, rows: 25 })).toBe(false);
    expect(sameReplayFitGrid(null, null)).toBe(true);
    expect(sameReplayFitGrid(null, { cols: 80, rows: 24 })).toBe(false);
  });
});
