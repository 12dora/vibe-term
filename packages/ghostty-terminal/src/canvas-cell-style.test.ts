import { describe, expect, test } from 'bun:test';
import {
  CellStyleResolver,
  blendFaint,
  blockElementCodepoint,
  cellBackgroundColor,
  cellForegroundColor,
  colorKey,
  fontVariantIndex,
  hasDecorations,
  hasVisibleGlyph,
  isSpacerCell,
} from './canvas-cell-style';
import type { GhosttyRenderCell, GhosttyRenderCellStyle, GhosttyRenderSnapshotMeta } from './types';

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

const COLORS: GhosttyRenderSnapshotMeta['colors'] = {
  background: { r: 0, g: 0, b: 0 },
  foreground: { r: 200, g: 200, b: 200 },
  cursor: null,
  palette: [],
};

function makeCell(overrides: Partial<GhosttyRenderCell> = {}): GhosttyRenderCell {
  return {
    x: 0,
    text: 'a',
    codepoints: [0x61],
    widthKind: 'narrow',
    hasText: true,
    style: STYLE,
    fgColor: null,
    bgColor: null,
    ...overrides,
  };
}

function withStyle(overrides: Partial<GhosttyRenderCellStyle>): GhosttyRenderCellStyle {
  return { ...STYLE, ...overrides };
}

describe('cell style predicates', () => {
  test('colorKey packs rgb into one integer', () => {
    expect(colorKey({ r: 1, g: 2, b: 3 })).toBe(0x010203);
    expect(colorKey({ r: 255, g: 255, b: 255 })).toBe(0xffffff);
  });

  test('fontVariantIndex maps italic/bold to the four variant slots', () => {
    expect(fontVariantIndex(STYLE)).toBe(0);
    expect(fontVariantIndex(withStyle({ italic: true }))).toBe(1);
    expect(fontVariantIndex(withStyle({ bold: true }))).toBe(2);
    expect(fontVariantIndex(withStyle({ bold: true, italic: true }))).toBe(3);
  });

  test('spacer cells carry no glyph', () => {
    expect(isSpacerCell(makeCell({ widthKind: 'spacer-head' }))).toBe(true);
    expect(isSpacerCell(makeCell({ widthKind: 'spacer-tail' }))).toBe(true);
    expect(isSpacerCell(makeCell({ widthKind: 'wide' }))).toBe(false);
    expect(hasVisibleGlyph(makeCell({ widthKind: 'spacer-tail' }))).toBe(false);
    expect(hasVisibleGlyph(makeCell({ text: '' }))).toBe(false);
    expect(hasVisibleGlyph(makeCell({ style: withStyle({ invisible: true }) }))).toBe(false);
    expect(hasVisibleGlyph(makeCell())).toBe(true);
  });

  test('hasDecorations covers underline, strikethrough and overline', () => {
    expect(hasDecorations(STYLE)).toBe(false);
    expect(hasDecorations(withStyle({ underline: 1 }))).toBe(true);
    expect(hasDecorations(withStyle({ strikethrough: true }))).toBe(true);
    expect(hasDecorations(withStyle({ overline: true }))).toBe(true);
  });

  test('inverse swaps foreground and background, defaults fall back to the snapshot', () => {
    const plain = makeCell();
    expect(cellForegroundColor(plain, COLORS)).toBe(COLORS.foreground);
    expect(cellBackgroundColor(plain, COLORS)).toBe(COLORS.background);

    const inverse = makeCell({
      style: withStyle({ inverse: true }),
      fgColor: { r: 10, g: 20, b: 30 },
      bgColor: { r: 40, g: 50, b: 60 },
    });
    expect(cellForegroundColor(inverse, COLORS)).toEqual({ r: 40, g: 50, b: 60 });
    expect(cellBackgroundColor(inverse, COLORS)).toEqual({ r: 10, g: 20, b: 30 });
  });

  test('blockElementCodepoint only accepts single-codepoint block glyphs', () => {
    expect(blockElementCodepoint(makeCell({ codepoints: [0x2588] }))).toBe(0x2588);
    expect(blockElementCodepoint(makeCell({ codepoints: [0x2580] }))).toBe(0x2580);
    expect(blockElementCodepoint(makeCell({ codepoints: [0x259f] }))).toBe(0x259f);
    expect(blockElementCodepoint(makeCell({ codepoints: [0x25a0] }))).toBe(-1);
    expect(blockElementCodepoint(makeCell({ codepoints: [0x2588, 0x0301] }))).toBe(-1);
  });
});

describe('CellStyleResolver colours', () => {
  test('toCss caches per packed colour', () => {
    const resolver = new CellStyleResolver('monospace');
    const css = resolver.toCss({ r: 1, g: 2, b: 3 });
    expect(css).toBe('rgb(1 2 3)');
    expect(resolver.toCss({ r: 1, g: 2, b: 3 })).toBe(css);
  });

  test('blendFaint mixes halfway toward the background', () => {
    expect(blendFaint({ r: 200, g: 100, b: 0 }, { r: 0, g: 0, b: 0 })).toEqual({
      r: 100,
      g: 50,
      b: 0,
    });
    expect(blendFaint({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toEqual({
      r: 128,
      g: 128,
      b: 128,
    });
    expect(blendFaint({ r: 33, g: 33, b: 33 }, { r: 33, g: 33, b: 33 })).toEqual({
      r: 33,
      g: 33,
      b: 33,
    });
  });

  test('faint dims the default foreground toward the default background', () => {
    const resolver = new CellStyleResolver('monospace');
    const cell = makeCell({ style: withStyle({ faint: true }) });
    expect(resolver.foregroundCss(cell, COLORS)).toBe('rgb(100 100 100)');
    expect(resolver.foregroundCss(makeCell(), COLORS)).toBe('rgb(200 200 200)');
  });

  test('faint dims a palette foreground against the cell background', () => {
    const resolver = new CellStyleResolver('monospace');
    const cell = makeCell({
      style: withStyle({ faint: true }),
      fgColor: { r: 255, g: 0, b: 0 },
      bgColor: { r: 0, g: 0, b: 100 },
    });
    expect(resolver.foregroundCss(cell, COLORS)).toBe('rgb(128 0 50)');
  });

  test('faint applies after inverse has swapped the colours', () => {
    const resolver = new CellStyleResolver('monospace');
    const cell = makeCell({
      style: withStyle({ faint: true, inverse: true }),
      fgColor: { r: 0, g: 0, b: 0 },
      bgColor: { r: 255, g: 255, b: 255 },
    });
    // inverse 后前景 = 原背景 255，背景 = 原前景 0，faint 再朝 0 混合一半。
    expect(resolver.foregroundCss(cell, COLORS)).toBe('rgb(128 128 128)');
  });

  test('faint and bold are independent: colour dims, weight stays', () => {
    const resolver = new CellStyleResolver('monospace');
    resolver.resetFonts(26);
    const cell = makeCell({ style: withStyle({ faint: true, bold: true }) });
    expect(resolver.foregroundCss(cell, COLORS)).toBe('rgb(100 100 100)');
    expect(resolver.resolveFont(cell.style)).toBe('700 26px monospace');
  });

  test('run 批绘按解析后的颜色聚合：faint 与等价显式色同键，与原色不同键', () => {
    const resolver = new CellStyleResolver('monospace');
    const faint = resolver.foregroundCss(makeCell({ style: withStyle({ faint: true }) }), COLORS);
    const explicit = resolver.foregroundCss(
      makeCell({ fgColor: { r: 100, g: 100, b: 100 } }),
      COLORS
    );
    expect(faint).toBe(explicit);
    expect(faint).not.toBe(resolver.foregroundCss(makeCell(), COLORS));
  });

  test('clearColors drops both the plain and the faint colour caches', () => {
    const resolver = new CellStyleResolver('monospace');
    const faintCell = makeCell({ style: withStyle({ faint: true }) });
    expect(resolver.foregroundCss(faintCell, COLORS)).toBe('rgb(100 100 100)');

    const nextColors: GhosttyRenderSnapshotMeta['colors'] = {
      ...COLORS,
      background: { r: 255, g: 255, b: 255 },
    };
    resolver.clearColors();
    expect(resolver.foregroundCss(faintCell, nextColors)).toBe('rgb(228 228 228)');
  });
});

describe('CellStyleResolver fonts', () => {
  test('resetFonts rebuilds every variant at the new size', () => {
    const resolver = new CellStyleResolver('Menlo');
    resolver.resetFonts(13);
    expect(resolver.resolveFont(STYLE)).toBe('13px Menlo');
    expect(resolver.resolveFont(withStyle({ italic: true }))).toBe('italic 13px Menlo');
    expect(resolver.resolveFont(withStyle({ bold: true, italic: true }))).toBe(
      'italic 700 13px Menlo'
    );

    resolver.resetFonts(26);
    expect(resolver.resolveFont(STYLE)).toBe('26px Menlo');
    expect(resolver.regularFont()).toBe('26px Menlo');
  });

  test('dispose clears the caches', () => {
    const resolver = new CellStyleResolver('Menlo');
    resolver.resetFonts(13);
    expect(resolver.resolveFont(STYLE)).toBe('13px Menlo');
    resolver.dispose();
    expect(resolver.resolveFont(STYLE)).toBe('13px Menlo');
    expect(resolver.toCss({ r: 9, g: 9, b: 9 })).toBe('rgb(9 9 9)');
  });
});
