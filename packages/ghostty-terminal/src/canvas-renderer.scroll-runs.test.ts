import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CanvasRenderer } from './canvas-renderer';
import type {
  GhosttyRenderCell,
  GhosttyRenderCellStyle,
  GhosttyRenderRow,
  GhosttyRenderSnapshotMeta,
  GhosttyTheme,
} from './types';

const CELL_WIDTH = 10;
const CELL_HEIGHT = 16;
const FONT_SIZE = 13;

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

const THEME = {
  selectionBackground: 'rgba(80,80,80,0.4)',
  foreground: '#eeeeee',
} as GhosttyTheme;

function paintToken(value: string, alpha: number): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash ^ Math.round(alpha * 255)) >>> 0;
}

class RasterContext {
  private fill = '';
  private currentFont = '';
  pixels = new Uint32Array();
  fillStyleAssignments = 0;
  fontAssignments = 0;
  fillTextCalls: string[] = [];
  fillRectCalls: Array<{ x: number; y: number; width: number; height: number; fill: string }> = [];
  drawImageCalls = 0;
  strokeStyle = '';
  lineWidth = 1;
  textBaseline = 'top';
  imageSmoothingEnabled = false;
  globalAlpha = 1;

  constructor(
    private readonly canvas: RasterCanvas,
    private readonly exactMeasure: boolean
  ) {}

  get fillStyle(): string {
    return this.fill;
  }

  set fillStyle(value: string) {
    this.fill = value;
    this.fillStyleAssignments += 1;
  }

  get font(): string {
    return this.currentFont;
  }

  set font(value: string) {
    this.currentFont = value;
    this.fontAssignments += 1;
  }

  resize(): void {
    this.pixels = new Uint32Array(this.canvas.width * this.canvas.height);
    this.fill = '';
    this.currentFont = '';
    this.globalAlpha = 1;
  }

  resetCounters(): void {
    this.fillStyleAssignments = 0;
    this.fontAssignments = 0;
    this.fillTextCalls = [];
    this.fillRectCalls = [];
    this.drawImageCalls = 0;
  }

  setTransform(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  stroke(): void {}
  setLineDash(): void {}
  strokeRect(): void {}

  measureText(text: string): TextMetrics {
    return {
      width: text.length * (this.exactMeasure ? CELL_WIDTH : CELL_WIDTH + 1),
      fontBoundingBoxAscent: FONT_SIZE * 0.8,
      fontBoundingBoxDescent: FONT_SIZE * 0.2,
    } as TextMetrics;
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    this.paintRect(x, y, width, height, 0);
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.fillRectCalls.push({ x, y, width, height, fill: this.fill });
    this.paintRect(x, y, width, height, paintToken(this.fill, this.globalAlpha));
  }

  fillText(text: string, x: number, y: number): void {
    this.fillTextCalls.push(text);
    let offset = 0;
    for (const character of text) {
      if (character !== ' ') {
        const token = paintToken(`${this.fill}|${this.currentFont}|${character}`, this.globalAlpha);
        this.paintRect(x + offset + 2, Math.round(y) - 5, 4, 5, token);
      }
      offset += CELL_WIDTH;
    }
  }

  drawImage(
    image: RasterCanvas,
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
    destinationX: number,
    destinationY: number,
    destinationWidth: number,
    destinationHeight: number
  ): void {
    this.drawImageCalls += 1;
    expect(destinationWidth).toBe(sourceWidth);
    expect(destinationHeight).toBe(sourceHeight);
    const source = image.context.pixels;
    for (let y = 0; y < sourceHeight; y += 1) {
      for (let x = 0; x < sourceWidth; x += 1) {
        const sourceIndex = (sourceY + y) * image.width + sourceX + x;
        const destinationIndex = (destinationY + y) * this.canvas.width + destinationX + x;
        this.pixels[destinationIndex] = source[sourceIndex];
      }
    }
  }

  private paintRect(x: number, y: number, width: number, height: number, value: number): void {
    const startX = Math.max(0, Math.floor(x));
    const startY = Math.max(0, Math.floor(y));
    const endX = Math.min(this.canvas.width, Math.ceil(x + width));
    const endY = Math.min(this.canvas.height, Math.ceil(y + height));
    for (let row = startY; row < endY; row += 1) {
      this.pixels.fill(value, row * this.canvas.width + startX, row * this.canvas.width + endX);
    }
  }
}

class RasterCanvas {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  readonly context: RasterContext;
  private bitmapWidth = 0;
  private bitmapHeight = 0;
  parentElement: RasterScreen | null = null;

  constructor(exactMeasure: boolean) {
    this.context = new RasterContext(this, exactMeasure);
  }

  get width(): number {
    return this.bitmapWidth;
  }

  set width(value: number) {
    this.bitmapWidth = value;
    this.context.resize();
  }

  get height(): number {
    return this.bitmapHeight;
  }

  set height(value: number) {
    this.bitmapHeight = value;
    this.context.resize();
  }

  getContext(): RasterContext {
    return this.context;
  }

  remove(): void {
    this.parentElement?.removeChild(this);
  }
}

class RasterScreen {
  style: Record<string, string> = {};
  children: RasterCanvas[] = [];

  appendChild(canvas: RasterCanvas): void {
    canvas.parentElement?.removeChild(canvas);
    canvas.parentElement = this;
    this.children.push(canvas);
  }

  insertBefore(canvas: RasterCanvas, reference: RasterCanvas): void {
    canvas.parentElement?.removeChild(canvas);
    const index = this.children.indexOf(reference);
    canvas.parentElement = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, canvas);
  }

  removeChild(canvas: RasterCanvas): void {
    this.children = this.children.filter((child) => child !== canvas);
    canvas.parentElement = null;
  }
}

function installRasterDom(exactMeasure: boolean): {
  renderer: CanvasRenderer;
  screen: RasterScreen;
  created: RasterCanvas[];
} {
  const created: RasterCanvas[] = [];
  (globalThis as { document?: unknown }).document = {
    createElement: () => {
      const canvas = new RasterCanvas(exactMeasure);
      created.push(canvas);
      return canvas;
    },
  };
  const screen = new RasterScreen();
  const renderer = new CanvasRenderer({
    screenElement: screen as unknown as HTMLElement,
    theme: THEME,
    fontFamily: 'monospace',
    fontSize: FONT_SIZE,
  });
  return { renderer, screen, created };
}

function makeMeta(cols: number, rows: number, dirty: GhosttyRenderSnapshotMeta['dirty']) {
  return {
    cols,
    rows,
    dirty,
    colors: {
      background: { r: 17, g: 17, b: 17 },
      foreground: { r: 238, g: 238, b: 238 },
      cursor: null,
      palette: [],
    },
    cursor: {
      style: 'block' as const,
      visible: false,
      blinking: false,
      passwordInput: false,
      x: null,
      y: null,
      wideTail: false,
    },
  };
}

function makeCell(
  x: number,
  text: string,
  overrides: Partial<GhosttyRenderCell> = {}
): GhosttyRenderCell {
  return {
    x,
    text,
    codepoints: text ? [text.codePointAt(0) ?? 32] : [],
    widthKind: 'narrow',
    hasText: text !== '',
    style: STYLE,
    fgColor: null,
    bgColor: null,
    ...overrides,
  };
}

function makeTextRow(y: number, text: string, dirty = true): GhosttyRenderRow {
  return {
    y,
    dirty,
    wrap: false,
    wrapContinuation: false,
    text,
    cells: Array.from(text, (character, x) => makeCell(x, character)),
  };
}

function mainContext(screen: RasterScreen): RasterContext {
  const canvas = screen.children.find((child) => child.dataset.layer === 'main');
  if (!canvas) {
    throw new Error('main canvas unavailable');
  }
  return canvas.context;
}

let previousDocument: unknown;
let previousDpr: unknown;

beforeEach(() => {
  previousDocument = (globalThis as { document?: unknown }).document;
  previousDpr = (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio;
  (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 1;
});

afterEach(() => {
  (globalThis as { document?: unknown }).document = previousDocument;
  (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio = previousDpr;
});

describe('CanvasRenderer run batching and scroll blitting', () => {
  test('empty narrow cells preserve grid spacing inside a text run', () => {
    const row: GhosttyRenderRow = {
      y: 0,
      dirty: true,
      wrap: false,
      wrapContinuation: false,
      text: 'A B',
      cells: [makeCell(0, 'A'), makeCell(1, ''), makeCell(2, 'B')],
    };
    const frame = {
      meta: makeMeta(3, 1, 'full'),
      rows: [row],
      cellDimensions: { width: CELL_WIDTH, height: CELL_HEIGHT },
    };

    const fallback = installRasterDom(false);
    fallback.renderer.render(frame);
    const fallbackPixels = fallback.created[0].context.pixels.slice();
    fallback.renderer.dispose();

    const batched = installRasterDom(true);
    batched.renderer.render(frame);
    expect(batched.created[0].context.fillTextCalls).toEqual(['A B']);
    expect(batched.created[0].context.pixels).toEqual(fallbackPixels);
    batched.renderer.dispose();
  });

  test('run batching is pixel-identical to the self-limited per-cell fallback', () => {
    const cells = [
      makeCell(0, 'A'),
      makeCell(1, 'B'),
      makeCell(2, 'C', { style: { ...STYLE, underline: 1 } }),
      makeCell(3, '█', { codepoints: [0x2588] }),
      makeCell(4, 'D', {
        style: { ...STYLE, italic: true },
        fgColor: { r: 255, g: 0, b: 0 },
        bgColor: { r: 0, g: 80, b: 0 },
      }),
      makeCell(5, 'E', {
        style: { ...STYLE, italic: true },
        fgColor: { r: 255, g: 0, b: 0 },
        bgColor: { r: 0, g: 80, b: 0 },
      }),
      makeCell(6, '界', { widthKind: 'wide' }),
      makeCell(7, '', { widthKind: 'spacer-tail' }),
    ];
    const row: GhosttyRenderRow = {
      y: 0,
      dirty: true,
      wrap: false,
      wrapContinuation: false,
      text: 'ABC█DE界',
      cells,
    };
    const frame = {
      meta: makeMeta(8, 1, 'full'),
      rows: [row],
      cellDimensions: { width: CELL_WIDTH, height: CELL_HEIGHT },
    };

    const fallback = installRasterDom(false);
    fallback.renderer.render(frame);
    const fallbackPixels = fallback.created[0].context.pixels.slice();
    const fallbackCalls = fallback.created[0].context.fillTextCalls;
    fallback.renderer.dispose();

    const batched = installRasterDom(true);
    batched.renderer.render(frame);
    const batchedContext = batched.created[0].context;

    expect(batchedContext.pixels).toEqual(fallbackPixels);
    expect(fallbackCalls).toEqual(['A', 'B', 'C', 'D', 'E', '界']);
    expect(batchedContext.fillTextCalls).toEqual(['AB', 'C', 'DE', '界']);
    expect(batchedContext.fillRectCalls).toContainEqual({
      x: 40,
      y: 0,
      width: 20,
      height: CELL_HEIGHT,
      fill: 'rgb(0 80 0)',
    });

    batchedContext.resetCounters();
    batched.renderer.render(frame);
    expect(batchedContext.fillTextCalls).toEqual(['AB', 'C', 'DE', '界']);
    expect(batchedContext.fontAssignments).toBe(2);
    expect(batchedContext.fillStyleAssignments).toBe(5);
    batched.renderer.dispose();
  });

  test('scratch-canvas blit plus exposed-row redraw matches a full-frame pixel oracle', () => {
    const oldRows = ['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD'].map((text, y) => makeTextRow(y, text));
    const newRows = [makeTextRow(0, 'ZZZZZZ'), ...oldRows.slice(0, 3)].map((row, y) => ({
      ...row,
      y,
      dirty: y === 0,
    }));
    const dimensions = { width: CELL_WIDTH, height: CELL_HEIGHT };

    const scrolled = installRasterDom(true);
    scrolled.renderer.render({
      meta: makeMeta(6, 4, 'full'),
      rows: oldRows,
      cellDimensions: dimensions,
    });
    for (const canvas of scrolled.created) {
      canvas.context.resetCounters();
    }
    scrolled.renderer.render({
      meta: makeMeta(6, 4, 'partial'),
      rows: newRows,
      cellDimensions: dimensions,
      scrollDelta: -1,
    });

    const oracle = installRasterDom(true);
    oracle.renderer.render({
      meta: makeMeta(6, 4, 'full'),
      rows: newRows.map((row) => ({ ...row, dirty: true })),
      cellDimensions: dimensions,
    });

    expect(scrolled.created[4].context.drawImageCalls).toBe(1);
    expect(scrolled.created[0].context.drawImageCalls).toBe(0);
    expect(mainContext(scrolled.screen).pixels).toEqual(mainContext(oracle.screen).pixels);
    expect(scrolled.renderer.getDebugState().lastDrawnRows).toEqual([0]);

    scrolled.renderer.dispose();
    oracle.renderer.dispose();
  });

  test('scratch-canvas blit preserves pixels when scrolling toward the bottom', () => {
    const oldRows = ['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD'].map((text, y) => makeTextRow(y, text));
    const newRows = [...oldRows.slice(1), makeTextRow(3, 'ZZZZZZ')].map((row, y) => ({
      ...row,
      y,
      dirty: y === 3,
    }));
    const dimensions = { width: CELL_WIDTH, height: CELL_HEIGHT };

    const scrolled = installRasterDom(true);
    scrolled.renderer.render({
      meta: makeMeta(6, 4, 'full'),
      rows: oldRows,
      cellDimensions: dimensions,
    });
    scrolled.renderer.render({
      meta: makeMeta(6, 4, 'partial'),
      rows: newRows,
      cellDimensions: dimensions,
      scrollDelta: 1,
    });

    const oracle = installRasterDom(true);
    oracle.renderer.render({
      meta: makeMeta(6, 4, 'full'),
      rows: newRows.map((row) => ({ ...row, dirty: true })),
      cellDimensions: dimensions,
    });

    expect(mainContext(scrolled.screen).pixels).toEqual(mainContext(oracle.screen).pixels);
    expect(scrolled.renderer.getDebugState().lastDrawnRows).toEqual([3]);
    expect(
      scrolled.screen.children.filter((canvas) => canvas.dataset.layer === 'main')
    ).toHaveLength(1);
    expect(
      scrolled.screen.children.filter((canvas) => canvas.dataset.layer === 'scratch')
    ).toHaveLength(1);

    const twiceRows = [...newRows.slice(1), makeTextRow(3, 'YYYYYY')].map((row, y) => ({
      ...row,
      y,
      dirty: y === 3,
    }));
    scrolled.renderer.render({
      meta: makeMeta(6, 4, 'partial'),
      rows: twiceRows,
      cellDimensions: dimensions,
      scrollDelta: 1,
    });
    oracle.renderer.render({
      meta: makeMeta(6, 4, 'full'),
      rows: twiceRows.map((row) => ({ ...row, dirty: true })),
      cellDimensions: dimensions,
    });
    expect(mainContext(scrolled.screen).pixels).toEqual(mainContext(oracle.screen).pixels);
    expect(scrolled.created[0].context.drawImageCalls).toBe(1);
    scrolled.renderer.dispose();
    oracle.renderer.dispose();
    expect(scrolled.screen.children).toHaveLength(0);
  });

  test('DPR changes bypass scroll blitting and force a full redraw', () => {
    const harness = installRasterDom(true);
    const rows = ['AAAA', 'BBBB', 'CCCC'].map((text, y) => makeTextRow(y, text));
    harness.renderer.render({
      meta: makeMeta(4, 3, 'full'),
      rows,
      cellDimensions: { width: CELL_WIDTH, height: CELL_HEIGHT },
    });
    for (const canvas of harness.created) {
      canvas.context.resetCounters();
    }

    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    harness.renderer.render({
      meta: makeMeta(4, 3, 'partial'),
      rows: rows.map((row, y) => ({ ...row, y, dirty: y === 0 })),
      cellDimensions: { width: CELL_WIDTH, height: CELL_HEIGHT },
      scrollDelta: -1,
    });

    // blit 被 dpr 变化绕过，共享中转画布因此从未被分配（只有四张层画布）。
    expect(harness.created).toHaveLength(4);
    expect(harness.created[0].context.drawImageCalls).toBe(0);
    expect(harness.renderer.getDebugState().lastDrawnRows).toEqual([0, 1, 2]);
    harness.renderer.dispose();
  });
});
