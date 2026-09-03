import { describe, expect, test } from 'bun:test';
import {
  type BlockElementSurface,
  drawBlockElement,
  drawCellDecorations,
  isBlockElement,
} from './canvas-block-elements';
import type { GhosttyRenderCellStyle } from './types';

const WIDTH = 8;
const HEIGHT = 16;

type Rect = { x: number; y: number; width: number; height: number; alpha: number };

class RecordingSurface {
  rects: Rect[] = [];
  globalAlpha = 1;

  fillRect(x: number, y: number, width: number, height: number): void {
    this.rects.push({ x, y, width, height, alpha: this.globalAlpha });
  }
}

function draw(codepoint: number, x = 0, y = 0): Rect[] {
  const surface = new RecordingSurface();
  drawBlockElement(surface as unknown as BlockElementSurface, codepoint, x, y, WIDTH, HEIGHT);
  expect(surface.globalAlpha).toBe(1);
  return surface.rects;
}

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

const METRICS = { cellHeight: HEIGHT, textTopGap: 2, glyphBoxHeight: 12, lineThickness: 1 };

function decorate(style: Partial<GhosttyRenderCellStyle>, y = 0): Rect[] {
  const surface = new RecordingSurface();
  drawCellDecorations(
    surface as unknown as CanvasRenderingContext2D,
    { ...STYLE, ...style },
    0,
    y,
    WIDTH,
    METRICS
  );
  return surface.rects;
}

describe('isBlockElement', () => {
  test('covers U+2580..U+259F only', () => {
    expect(isBlockElement(0x257f)).toBe(false);
    expect(isBlockElement(0x2580)).toBe(true);
    expect(isBlockElement(0x259f)).toBe(true);
    expect(isBlockElement(0x25a0)).toBe(false);
  });
});

describe('drawBlockElement', () => {
  test('▀ fills the upper half', () => {
    expect(draw(0x2580)).toEqual([{ x: 0, y: 0, width: WIDTH, height: HEIGHT / 2, alpha: 1 }]);
  });

  test('█ fills the whole cell and ▁ only the bottom eighth', () => {
    expect(draw(0x2588)).toEqual([{ x: 0, y: 0, width: WIDTH, height: HEIGHT, alpha: 1 }]);
    expect(draw(0x2581)).toEqual([{ x: 0, y: HEIGHT - 2, width: WIDTH, height: 2, alpha: 1 }]);
  });

  test('▌ and ▏ fill left runs, ▐ and ▕ fill right runs', () => {
    expect(draw(0x258c)).toEqual([{ x: 0, y: 0, width: WIDTH / 2, height: HEIGHT, alpha: 1 }]);
    expect(draw(0x258f)).toEqual([{ x: 0, y: 0, width: 1, height: HEIGHT, alpha: 1 }]);
    expect(draw(0x2590)).toEqual([
      { x: WIDTH / 2, y: 0, width: WIDTH / 2, height: HEIGHT, alpha: 1 },
    ]);
    expect(draw(0x2595)).toEqual([{ x: 7, y: 0, width: 1, height: HEIGHT, alpha: 1 }]);
  });

  test('▔ fills the top eighth', () => {
    expect(draw(0x2594)).toEqual([{ x: 0, y: 0, width: WIDTH, height: 2, alpha: 1 }]);
  });

  test('░▒▓ fill the whole cell at 25/50/75% alpha and restore globalAlpha', () => {
    expect(draw(0x2591)).toEqual([{ x: 0, y: 0, width: WIDTH, height: HEIGHT, alpha: 0.25 }]);
    expect(draw(0x2592)).toEqual([{ x: 0, y: 0, width: WIDTH, height: HEIGHT, alpha: 0.5 }]);
    expect(draw(0x2593)).toEqual([{ x: 0, y: 0, width: WIDTH, height: HEIGHT, alpha: 0.75 }]);
  });

  test('quadrant blocks fill the right corners', () => {
    expect(draw(0x2598)).toEqual([{ x: 0, y: 0, width: 4, height: 8, alpha: 1 }]);
    expect(draw(0x259d)).toEqual([{ x: 4, y: 0, width: 4, height: 8, alpha: 1 }]);
    expect(draw(0x2596)).toEqual([{ x: 0, y: 8, width: 4, height: 8, alpha: 1 }]);
    expect(draw(0x2597)).toEqual([{ x: 4, y: 8, width: 4, height: 8, alpha: 1 }]);
    expect(draw(0x259e)).toEqual([
      { x: 4, y: 0, width: 4, height: 8, alpha: 1 },
      { x: 0, y: 8, width: 4, height: 8, alpha: 1 },
    ]);
  });

  test('drawing offsets translate every rect', () => {
    expect(draw(0x2588, 30, 40)).toEqual([
      { x: 30, y: 40, width: WIDTH, height: HEIGHT, alpha: 1 },
    ]);
  });
});

describe('drawCellDecorations', () => {
  test('no decorations means no fills', () => {
    expect(decorate({})).toEqual([]);
  });

  test('underline sits at the glyph box bottom and stays inside the cell', () => {
    expect(decorate({ underline: 1 })).toEqual([
      { x: 0, y: 13, width: WIDTH - 1, height: 1, alpha: 1 },
    ]);
    expect(decorate({ underline: 1 }, 32)).toEqual([
      { x: 0, y: 45, width: WIDTH - 1, height: 1, alpha: 1 },
    ]);
  });

  test('an overflowing glyph box clamps the underline to the cell bottom', () => {
    const surface = new RecordingSurface();
    drawCellDecorations(
      surface as unknown as CanvasRenderingContext2D,
      { ...STYLE, underline: 1 },
      0,
      0,
      WIDTH,
      { cellHeight: HEIGHT, textTopGap: 2, glyphBoxHeight: 40, lineThickness: 1 }
    );
    expect(surface.rects).toEqual([{ x: 0, y: HEIGHT - 1, width: WIDTH - 1, height: 1, alpha: 1 }]);
  });

  test('strikethrough crosses the glyph box middle and overline hugs its top', () => {
    expect(decorate({ strikethrough: true })).toEqual([
      { x: 0, y: 8, width: WIDTH - 1, height: 1, alpha: 1 },
    ]);
    expect(decorate({ overline: true })).toEqual([
      { x: 0, y: 2, width: WIDTH - 1, height: 1, alpha: 1 },
    ]);
  });

  test('all three decorations paint in underline / strikethrough / overline order', () => {
    expect(decorate({ underline: 2, strikethrough: true, overline: true })).toHaveLength(3);
  });

  test('a thick line never collapses the run width', () => {
    const surface = new RecordingSurface();
    drawCellDecorations(
      surface as unknown as CanvasRenderingContext2D,
      { ...STYLE, overline: true },
      0,
      0,
      2,
      { cellHeight: HEIGHT, textTopGap: 2, glyphBoxHeight: 12, lineThickness: 4 }
    );
    expect(surface.rects).toEqual([{ x: 0, y: 2, width: 4, height: 4, alpha: 1 }]);
  });
});
