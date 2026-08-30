// 选区层与光标层是独立 canvas，与主画布的按行重绘无关：它们只应在自身状态
// （矩形集 / 颜色 / 光标位置形状闪烁）或画布尺寸变化时动笔，否则每帧全层 clearRect
// 会把「只画脏行」的收益抵消掉。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CanvasRenderer } from './canvas-renderer';
import type {
  GhosttyCellDimensions,
  GhosttyRenderSnapshotMeta,
  GhosttySelectionRect,
  GhosttyTheme,
} from './types';

type DrawOp = {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fillStyle?: string;
};

const FONT_SIZE = 13;
const CELL: GhosttyCellDimensions = { width: 10, height: 20 };

class FakeCtx {
  fillStyle = '';
  strokeStyle = '';
  font = '';
  lineWidth = 1;
  textBaseline = 'top';
  imageSmoothingEnabled = false;
  globalAlpha = 1;
  ops: DrawOp[] = [];
  setTransform(): void {}
  clearRect(x: number, y: number, width: number, height: number): void {
    this.ops.push({ type: 'clearRect', x, y, width, height });
  }
  fillRect(x: number, y: number, width: number, height: number): void {
    this.ops.push({ type: 'fillRect', x, y, width, height, fillStyle: this.fillStyle });
  }
  fillText(): void {}
  strokeRect(x: number, y: number, width: number, height: number): void {
    this.ops.push({ type: 'strokeRect', x, y, width, height });
  }
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  stroke(): void {}
  setLineDash(): void {}
  measureText(): {
    fontBoundingBoxAscent: number;
    fontBoundingBoxDescent: number;
    width: number;
  } {
    const px = Number.parseFloat(this.font) || FONT_SIZE;
    return { fontBoundingBoxAscent: px * 0.8, fontBoundingBoxDescent: px * 0.3, width: px * 0.6 };
  }
}

class FakeCanvas {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  width = 0;
  height = 0;
  readonly ctx = new FakeCtx();
  getContext(): FakeCtx {
    return this.ctx;
  }
  remove(): void {}
}

class FakeScreen {
  style: Record<string, string> = {};
  children: FakeCanvas[] = [];
  appendChild(child: FakeCanvas): void {
    this.children.push(child);
  }
}

const THEME = {
  selectionBackground: 'rgba(80,80,80,0.4)',
  foreground: '#eeeeee',
} as unknown as GhosttyTheme;

function makeMeta(
  cursor: Partial<GhosttyRenderSnapshotMeta['cursor']> = {},
  dirty: GhosttyRenderSnapshotMeta['dirty'] = 'clean'
): GhosttyRenderSnapshotMeta {
  return {
    cols: 4,
    rows: 4,
    dirty,
    colors: {
      background: { r: 0, g: 0, b: 0 },
      foreground: { r: 200, g: 200, b: 200 },
      cursor: { r: 255, g: 0, b: 0 },
      palette: [],
    },
    cursor: {
      style: 'block',
      visible: true,
      blinking: false,
      passwordInput: false,
      x: 1,
      y: 2,
      wideTail: false,
      ...cursor,
    },
  };
}

let previousDpr: unknown;
let previousDocument: unknown;
let previousSetInterval: typeof globalThis.setInterval;
let previousClearInterval: typeof globalThis.clearInterval;

function setup(): {
  renderer: CanvasRenderer;
  mainCanvas: FakeCanvas;
  selectionCanvas: FakeCanvas;
  cursorCanvas: FakeCanvas;
} {
  (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 1;
  const created: FakeCanvas[] = [];
  (globalThis as { document?: unknown }).document = {
    createElement: () => {
      const canvas = new FakeCanvas();
      created.push(canvas);
      return canvas;
    },
  };
  const screen = new FakeScreen();
  const renderer = new CanvasRenderer({
    screenElement: screen as unknown as HTMLElement,
    theme: THEME,
    fontFamily: 'monospace',
    fontSize: FONT_SIZE,
  });

  // 构造顺序：main / link / selection / cursor
  return {
    renderer,
    mainCanvas: created[0],
    selectionCanvas: created[2],
    cursorCanvas: created[3],
  };
}

function drain(canvas: FakeCanvas): DrawOp[] {
  const ops = canvas.ctx.ops;
  canvas.ctx.ops = [];
  return ops;
}

function renderFrame(
  renderer: CanvasRenderer,
  options: {
    selectionRects?: GhosttySelectionRect[];
    selectionColor?: string;
    cursor?: Partial<GhosttyRenderSnapshotMeta['cursor']>;
  } = {}
): void {
  renderer.render({
    meta: makeMeta(options.cursor),
    rows: [],
    cellDimensions: CELL,
    selectionRects: options.selectionRects,
    selectionColor: options.selectionColor,
  });
}

beforeEach(() => {
  previousDpr = (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio;
  previousDocument = (globalThis as { document?: unknown }).document;
  previousSetInterval = globalThis.setInterval;
  previousClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (() =>
    1 as unknown as ReturnType<typeof setInterval>) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = (() => {}) as unknown as typeof globalThis.clearInterval;
});

afterEach(() => {
  (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio = previousDpr;
  (globalThis as { document?: unknown }).document = previousDocument;
  globalThis.setInterval = previousSetInterval;
  globalThis.clearInterval = previousClearInterval;
});

describe('选区层只在选区状态变化时重画', () => {
  // 拖拽期间的每帧入口：只重画选区层，主画布与光标层一笔都不动。
  test('drawSelectionOnly 不碰主画布与光标层，且对同一批矩形去重', () => {
    const { renderer, mainCanvas, selectionCanvas, cursorCanvas } = setup();
    renderFrame(renderer, { selectionRects: [{ row: 0, x: 1, width: 2 }] });
    drain(mainCanvas);
    drain(selectionCanvas);
    drain(cursorCanvas);

    renderer.drawSelectionOnly([{ row: 1, x: 0, width: 3 }], 'rgba(9,9,9,0.5)');
    expect(drain(selectionCanvas).length).toBeGreaterThan(0);
    expect(drain(mainCanvas)).toEqual([]);
    expect(drain(cursorCanvas)).toEqual([]);

    renderer.drawSelectionOnly([{ row: 1, x: 0, width: 3 }], 'rgba(9,9,9,0.5)');
    expect(drain(selectionCanvas)).toEqual([]);
  });

  test('无选区的连续帧不碰选区层', () => {
    const { renderer, selectionCanvas } = setup();
    renderFrame(renderer);
    expect(drain(selectionCanvas).length).toBeGreaterThan(0);

    renderFrame(renderer);
    renderFrame(renderer);
    expect(drain(selectionCanvas)).toEqual([]);
  });

  test('选区出现 / 变化 / 消失各触发一次重画', () => {
    const { renderer, selectionCanvas } = setup();
    renderFrame(renderer);
    drain(selectionCanvas);

    renderFrame(renderer, { selectionRects: [{ row: 0, x: 1, width: 2 }] });
    const appeared = drain(selectionCanvas);
    expect(appeared[0]?.type).toBe('clearRect');
    expect(appeared.filter((op) => op.type === 'fillRect')).toEqual([
      {
        type: 'fillRect',
        x: 10,
        y: 0,
        width: 20,
        height: 20,
        fillStyle: THEME.selectionBackground,
      },
    ]);

    // 同一组矩形（新数组、值相同）→ 不重画
    renderFrame(renderer, { selectionRects: [{ row: 0, x: 1, width: 2 }] });
    expect(drain(selectionCanvas)).toEqual([]);

    renderFrame(renderer, { selectionRects: [{ row: 0, x: 1, width: 3 }] });
    expect(drain(selectionCanvas).some((op) => op.type === 'fillRect')).toBeTrue();

    renderFrame(renderer, { selectionRects: [] });
    const cleared = drain(selectionCanvas);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.type).toBe('clearRect');
  });

  test('仅选区颜色变化也触发重画', () => {
    const { renderer, selectionCanvas } = setup();
    const rects = [{ row: 1, x: 0, width: 2 }];
    renderFrame(renderer, { selectionRects: rects });
    drain(selectionCanvas);

    renderFrame(renderer, { selectionRects: rects, selectionColor: 'rgba(1,2,3,0.5)' });
    expect(drain(selectionCanvas).some((op) => op.fillStyle === 'rgba(1,2,3,0.5)')).toBeTrue();
  });

  test('画布被 resize 清空后选区层必须重画', () => {
    const { renderer, selectionCanvas } = setup();
    renderFrame(renderer, { selectionRects: [{ row: 0, x: 0, width: 1 }] });
    drain(selectionCanvas);

    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    renderFrame(renderer, { selectionRects: [{ row: 0, x: 0, width: 1 }] });
    expect(drain(selectionCanvas).some((op) => op.type === 'fillRect')).toBeTrue();
  });
});

describe('光标层只在光标状态变化时重画', () => {
  test('光标不动的连续帧完全不碰光标层', () => {
    const { renderer, cursorCanvas } = setup();
    renderFrame(renderer);
    expect(drain(cursorCanvas).some((op) => op.type === 'fillRect')).toBeTrue();

    renderFrame(renderer);
    renderFrame(renderer);
    expect(drain(cursorCanvas)).toEqual([]);
  });

  test('光标移动时只擦上一格，不整层 clearRect', () => {
    const { renderer, cursorCanvas } = setup();
    renderFrame(renderer);
    drain(cursorCanvas);

    renderFrame(renderer, { cursor: { x: 3, y: 1 } });
    const ops = drain(cursorCanvas);
    expect(ops[0]).toEqual({ type: 'clearRect', x: 10, y: 40, width: 10, height: 20 });
    expect(ops[1]).toEqual({
      type: 'fillRect',
      x: 30,
      y: 20,
      width: 10,
      height: 20,
      fillStyle: 'rgb(255 0 0)',
    });
  });

  test('光标隐藏时擦掉上一格；持续隐藏不再动笔', () => {
    const { renderer, cursorCanvas } = setup();
    renderFrame(renderer);
    drain(cursorCanvas);

    renderFrame(renderer, { cursor: { visible: false } });
    expect(drain(cursorCanvas)).toEqual([
      { type: 'clearRect', x: 10, y: 40, width: 10, height: 20 },
    ]);

    renderFrame(renderer, { cursor: { visible: false } });
    expect(drain(cursorCanvas)).toEqual([]);
  });

  test('画布被 resize 清空后光标层整层擦并重画', () => {
    const { renderer, cursorCanvas } = setup();
    renderFrame(renderer);
    drain(cursorCanvas);

    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    renderFrame(renderer);
    const ops = drain(cursorCanvas);
    expect(ops[0]).toEqual({
      type: 'clearRect',
      x: 0,
      y: 0,
      width: cursorCanvas.width,
      height: cursorCanvas.height,
    });
    expect(ops.some((op) => op.type === 'fillRect')).toBeTrue();
  });

  test('仅光标颜色变化也触发重画', () => {
    const { renderer, cursorCanvas } = setup();
    renderFrame(renderer);
    drain(cursorCanvas);

    const meta = makeMeta();
    meta.colors = { ...meta.colors, cursor: { r: 0, g: 255, b: 0 } };
    renderer.render({ meta, rows: [], cellDimensions: CELL });
    expect(drain(cursorCanvas).some((op) => op.fillStyle === 'rgb(0 255 0)')).toBeTrue();
  });
});
