// readRow 拆出的两个纯函数：cell 级「内容是否变了」与 row 级「能否整行复用」。
// 二者共同决定 GhosttyRenderRow.dirty，进而决定 canvas 只重画哪些行。
import { describe, expect, test } from 'bun:test';
import { isCellUnchanged, reuseUnchangedRow } from './render-state';
import type {
  GhosttyColorRgb,
  GhosttyRenderCell,
  GhosttyRenderCellStyle,
  GhosttyRenderRow,
} from './types';

const STYLE: GhosttyRenderCellStyle = {
  bold: false,
  italic: false,
  faint: false,
  blink: false,
  inverse: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: 0,
};

const OTHER_STYLE: GhosttyRenderCellStyle = { ...STYLE, bold: true };
const RED: GhosttyColorRgb = { r: 255, g: 0, b: 0 };
const SAME_RED: GhosttyColorRgb = { r: 255, g: 0, b: 0 };

function cell(overrides: Partial<GhosttyRenderCell> = {}): GhosttyRenderCell {
  return {
    x: 0,
    text: 'a',
    codepoints: [97],
    widthKind: 'narrow',
    hasText: true,
    style: STYLE,
    fgColor: null,
    bgColor: null,
    ...overrides,
  };
}

function row(overrides: Partial<GhosttyRenderRow> = {}): GhosttyRenderRow {
  return {
    y: 3,
    dirty: false,
    wrap: false,
    wrapContinuation: false,
    text: 'a',
    cells: [cell()],
    ...overrides,
  };
}

describe('isCellUnchanged', () => {
  test('全部字段一致时判定未变', () => {
    expect(isCellUnchanged(cell(), 'a', 1, 'narrow', true, STYLE, null, null)).toBe(true);
  });

  test('文本、码位数、宽度类型、hasText 任一不同都判定已变', () => {
    expect(isCellUnchanged(cell(), 'b', 1, 'narrow', true, STYLE, null, null)).toBe(false);
    expect(isCellUnchanged(cell(), 'a', 2, 'narrow', true, STYLE, null, null)).toBe(false);
    expect(isCellUnchanged(cell(), 'a', 1, 'wide', true, STYLE, null, null)).toBe(false);
    expect(isCellUnchanged(cell(), 'a', 1, 'narrow', false, STYLE, null, null)).toBe(false);
  });

  test('style 与颜色按引用比对：内插实例才算相同', () => {
    expect(isCellUnchanged(cell(), 'a', 1, 'narrow', true, OTHER_STYLE, null, null)).toBe(false);

    const colored = cell({ fgColor: RED });
    expect(isCellUnchanged(colored, 'a', 1, 'narrow', true, STYLE, RED, null)).toBe(true);
    // 值相等但不是同一个内插实例 → 视作已变（内插表保证同色同实例）。
    expect(isCellUnchanged(colored, 'a', 1, 'narrow', true, STYLE, SAME_RED, null)).toBe(false);
    expect(isCellUnchanged(colored, 'a', 1, 'narrow', true, STYLE, null, null)).toBe(false);
  });
});

describe('reuseUnchangedRow', () => {
  test('上一帧不脏且行属性一致时原样复用同一对象', () => {
    const previous = row();
    expect(reuseUnchangedRow(previous, 3, 1, false, false)).toBe(previous);
  });

  test('上一帧标脏时换一层 dirty=false 的外壳，cells / text 仍复用引用', () => {
    const previous = row({ dirty: true });
    const reused = reuseUnchangedRow(previous, 7, 1, false, false);

    expect(reused).not.toBeNull();
    expect(reused).not.toBe(previous);
    expect(reused?.dirty).toBe(false);
    expect(reused?.y).toBe(7);
    expect(reused?.cells).toBe(previous.cells);
    expect(reused?.text).toBe(previous.text);
  });

  test('没有上一帧、cell 数不同、wrap 标记不同时都不复用', () => {
    expect(reuseUnchangedRow(null, 3, 1, false, false)).toBeNull();
    expect(reuseUnchangedRow(row(), 3, 2, false, false)).toBeNull();
    expect(reuseUnchangedRow(row(), 3, 1, true, false)).toBeNull();
    expect(reuseUnchangedRow(row(), 3, 1, false, true)).toBeNull();
  });
});
