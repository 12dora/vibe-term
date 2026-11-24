// 预测层：叠层顺序、随 resize / dpr 缩放与清空、overlay 落笔规则、重画时机与光标覆盖。
// 与 canvas-renderer.layers.test.ts 同一套 fake canvas，只额外记录 fillText。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CanvasRenderer } from './canvas-renderer';
import type {
  GhosttyCellDimensions,
  GhosttyRenderSnapshotMeta,
  GhosttyTheme,
  PredictionOverlay,
} from './types';

type DrawOp = {
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  fillStyle?: string;
};

const FONT_SIZE = 13;
const CELL: GhosttyCellDimensions = { width: 10, height: 20 };
// FakeCtx.measureText：ascent = 0.8em、descent = 0.3em → 字形盒 14.3；cell 高 20
// → textTopGap = round(2.85) = 3，textBaselineY = round(3 + 10.4) = 13，
// 下划线 y = round(3 + 14.3 - 1) = 16（dpr 1，线宽 1）。
const BASELINE_Y = 13;
const UNDERLINE_Y = 16;
const BG = 'rgb(0 0 0)';
const FG = 'rgb(200 200 200)';

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
  fillText(text: string, x: number, y: number): void {
    this.ops.push({ type: 'fillText', x, y, text, fillStyle: this.fillStyle });
  }
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
  insertBefore(child: FakeCanvas, reference: FakeCanvas): void {
    const index = this.children.indexOf(reference);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
  }
}

const THEME = {
  selectionBackground: 'rgba(80,80,80,0.4)',
  foreground: '#eeeeee',
} as unknown as GhosttyTheme;

function makeMeta(
  cursor: Partial<GhosttyRenderSnapshotMeta['cursor']> = {},
  size: { cols: number; rows: number } = { cols: 4, rows: 4 },
  colors: Partial<GhosttyRenderSnapshotMeta['colors']> = {}
): GhosttyRenderSnapshotMeta {
  return {
    cols: size.cols,
    rows: size.rows,
    dirty: 'clean',
    colors: {
      background: { r: 0, g: 0, b: 0 },
      foreground: { r: 200, g: 200, b: 200 },
      cursor: { r: 255, g: 0, b: 0 },
      palette: [],
      ...colors,
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
  screen: FakeScreen;
  prediction: () => FakeCanvas;
  mainCanvas: FakeCanvas;
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

  // 构造顺序：main / link / selection / cursor；prediction 在首个非空 overlay 时才创建
  return {
    renderer,
    screen,
    mainCanvas: created[0],
    prediction: () => predictionLayerOf(screen),
    cursorCanvas: created[3],
  };
}

function predictionLayerOf(screen: FakeScreen): FakeCanvas {
  const canvas = screen.children.find((child) => child.dataset.layer === 'prediction');
  if (!canvas) {
    throw new Error('prediction layer not created');
  }
  return canvas;
}

function layerNames(screen: FakeScreen): string[] {
  return screen.children.map((canvas) => canvas.dataset.layer ?? '');
}

function drain(canvas: FakeCanvas): DrawOp[] {
  const ops = canvas.ctx.ops;
  canvas.ctx.ops = [];
  return ops;
}

function renderFrame(
  renderer: CanvasRenderer,
  options: {
    cursor?: Partial<GhosttyRenderSnapshotMeta['cursor']>;
    size?: { cols: number; rows: number };
    colors?: Partial<GhosttyRenderSnapshotMeta['colors']>;
    cursorSettled?: boolean;
  } = {}
): void {
  renderer.render({
    meta: makeMeta(options.cursor, options.size, options.colors),
    rows: [],
    cellDimensions: CELL,
    cursorSettled: options.cursorSettled,
  });
}

const OVERLAY: PredictionOverlay = {
  cells: [
    { row: 1, col: 0, text: 'a', wide: false, underline: false },
    { row: 1, col: 1, text: '中', wide: true, underline: true },
  ],
  cursor: null,
};

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

describe('预测层叠放与尺寸', () => {
  test('没有非空 overlay 之前不创建；null 也不创建', () => {
    const { renderer, screen } = setup();
    expect(layerNames(screen)).toEqual(['main', 'link', 'selection', 'cursor']);

    renderFrame(renderer);
    renderer.setPredictionOverlay(null);
    renderFrame(renderer, { size: { cols: 6, rows: 3 } });
    expect(layerNames(screen)).toEqual(['main', 'link', 'selection', 'cursor']);
  });

  test('首个非空 overlay 创建预测层：位于 link 之后、selection / cursor 之前，且不拦截指针', () => {
    const { renderer, screen } = setup();
    renderFrame(renderer);
    renderer.setPredictionOverlay(OVERLAY);
    expect(layerNames(screen)).toEqual(['main', 'link', 'prediction', 'selection', 'cursor']);
    const prediction = screen.children[2];
    expect(prediction.style.pointerEvents).toBe('none');
    expect(prediction.style.position).toBe('absolute');

    renderer.setPredictionOverlay({ cells: [OVERLAY.cells[0]], cursor: null });
    renderer.setPredictionOverlay(null);
    renderer.setPredictionOverlay(OVERLAY);
    expect(layerNames(screen)).toEqual(['main', 'link', 'prediction', 'selection', 'cursor']);
  });

  test('仅带光标覆盖的 overlay 同样创建预测层', () => {
    const { renderer, screen } = setup();
    renderFrame(renderer);
    renderer.setPredictionOverlay({ cells: [], cursor: { row: 0, col: 3 } });
    expect(layerNames(screen)).toEqual(['main', 'link', 'prediction', 'selection', 'cursor']);
  });

  test('创建时已有网格则立即按当前网格与 dpr 定尺寸', () => {
    const { renderer, mainCanvas, prediction } = setup();
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    renderFrame(renderer, { size: { cols: 6, rows: 3 } });
    renderer.setPredictionOverlay(OVERLAY);

    expect(prediction().width).toBe(6 * 20);
    expect(prediction().height).toBe(3 * 40);
    expect(prediction().width).toBe(mainCanvas.width);
    expect(prediction().height).toBe(mainCanvas.height);
    expect(prediction().style.width).toBe(mainCanvas.style.width);
    expect(prediction().style.height).toBe(mainCanvas.style.height);
  });

  test('首帧之前创建的预测层在首帧定尺寸', () => {
    const { renderer, mainCanvas, prediction } = setup();
    renderer.setPredictionOverlay(OVERLAY);
    expect(prediction().width).toBe(0);

    renderFrame(renderer);
    expect(prediction().width).toBe(4 * CELL.width);
    expect(prediction().height).toBe(mainCanvas.height);
  });

  test('创建之后随网格与 dpr 同步重设位图尺寸', () => {
    const { renderer, mainCanvas, prediction } = setup();
    renderFrame(renderer);
    renderer.setPredictionOverlay(OVERLAY);
    expect(prediction().width).toBe(mainCanvas.width);
    expect(prediction().height).toBe(mainCanvas.height);
    expect(prediction().width).toBe(4 * CELL.width);
    expect(prediction().style.width).toBe(mainCanvas.style.width);

    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    renderFrame(renderer);
    expect(prediction().width).toBe(80);
    expect(prediction().height).toBe(160);
    expect(prediction().style.height).toBe(mainCanvas.style.height);

    renderFrame(renderer, { size: { cols: 6, rows: 3 } });
    expect(prediction().width).toBe(6 * 20);
    expect(prediction().height).toBe(3 * 40);
  });

  test('有 overlay 的常态帧不重画预测层', () => {
    const { renderer, prediction } = setup();
    renderFrame(renderer);
    renderer.setPredictionOverlay(OVERLAY);
    drain(prediction());

    renderFrame(renderer);
    renderFrame(renderer);
    expect(drain(prediction())).toEqual([]);
  });

  test('dispose 移除预测层画布', () => {
    const { renderer, screen } = setup();
    renderFrame(renderer);
    renderer.setPredictionOverlay(OVERLAY);
    const canvas = predictionLayerOf(screen);
    let removed = false;
    canvas.remove = () => {
      removed = true;
    };
    renderer.dispose();
    expect(removed).toBeTrue();
  });
});

describe('overlay 落笔规则', () => {
  test('每格先铺默认底色再画默认前景字形；宽字符占两格；underline 画一条 1 物理像素线', () => {
    const { renderer, prediction } = setup();
    renderFrame(renderer);

    renderer.setPredictionOverlay(OVERLAY);
    expect(drain(prediction())).toEqual([
      { type: 'clearRect', x: 0, y: 0, width: 40, height: 80 },
      { type: 'fillRect', x: 0, y: 20, width: 10, height: 20, fillStyle: BG },
      { type: 'fillText', x: 0, y: 20 + BASELINE_Y, text: 'a', fillStyle: FG },
      { type: 'fillRect', x: 10, y: 20, width: 20, height: 20, fillStyle: BG },
      { type: 'fillText', x: 10, y: 20 + BASELINE_Y, text: '中', fillStyle: FG },
      { type: 'fillRect', x: 10, y: 20 + UNDERLINE_Y, width: 20, height: 1, fillStyle: FG },
    ]);
    expect(prediction().ctx.font).not.toBe('');
  });

  test('dpr 2 下按设备像素落笔，线宽随 dpr', () => {
    const { renderer, prediction } = setup();
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    renderFrame(renderer);

    renderer.setPredictionOverlay({
      cells: [{ row: 1, col: 1, text: 'x', wide: false, underline: true }],
      cursor: null,
    });
    const ops = drain(prediction());
    expect(ops[1]).toEqual({
      type: 'fillRect',
      x: 20,
      y: 40,
      width: 20,
      height: 40,
      fillStyle: BG,
    });
    const underline = ops.at(-1);
    expect(underline?.type).toBe('fillRect');
    expect(underline?.x).toBe(20);
    expect(underline?.width).toBe(20);
    expect(underline?.height).toBe(2);
    expect(Number.isInteger(underline?.y)).toBeTrue();
  });

  test('空白字符只铺底色不落字；越界格与越过末列的宽字符被跳过', () => {
    const { renderer, prediction } = setup();
    renderFrame(renderer);

    renderer.setPredictionOverlay({
      cells: [
        { row: 0, col: 0, text: ' ', wide: false, underline: false },
        { row: 4, col: 0, text: 'x', wide: false, underline: false },
        { row: 0, col: 4, text: 'x', wide: false, underline: false },
        { row: -1, col: 0, text: 'x', wide: false, underline: false },
        { row: 0, col: 3, text: '中', wide: true, underline: false },
      ],
      cursor: null,
    });
    const ops = drain(prediction());
    expect(ops.filter((op) => op.type === 'fillText')).toEqual([]);
    expect(ops.filter((op) => op.type === 'fillRect')).toEqual([
      { type: 'fillRect', x: 0, y: 0, width: 10, height: 20, fillStyle: BG },
    ]);
  });

  test('相同内容不重画；内容变化整层重画；null 只擦一次', () => {
    const { renderer, prediction } = setup();
    renderFrame(renderer);
    renderer.setPredictionOverlay(OVERLAY);
    drain(prediction());

    renderer.setPredictionOverlay({
      cells: OVERLAY.cells.map((cell) => ({ ...cell })),
      cursor: null,
    });
    expect(drain(prediction())).toEqual([]);

    renderer.setPredictionOverlay({ cells: [OVERLAY.cells[0]], cursor: null });
    const changed = drain(prediction());
    expect(changed[0]?.type).toBe('clearRect');
    expect(changed.filter((op) => op.type === 'fillText')).toHaveLength(1);

    renderer.setPredictionOverlay(null);
    expect(drain(prediction())).toEqual([{ type: 'clearRect', x: 0, y: 0, width: 40, height: 80 }]);
    renderer.setPredictionOverlay(null);
    expect(drain(prediction())).toEqual([]);
  });

  test('宿主事后改动传入的对象不影响已落笔内容的比对', () => {
    const { renderer, prediction } = setup();
    renderFrame(renderer);
    const cells = [{ row: 0, col: 0, text: 'a', wide: false, underline: false }];
    renderer.setPredictionOverlay({ cells, cursor: null });
    drain(prediction());

    cells[0].text = 'b';
    renderer.setPredictionOverlay({ cells, cursor: null });
    expect(drain(prediction()).some((op) => op.text === 'b')).toBeTrue();
  });

  test('主画布帧、滚动不重画预测层；位图被清空（dpr）或配色变化才重画', () => {
    const { renderer, prediction } = setup();
    renderFrame(renderer);
    renderer.setPredictionOverlay(OVERLAY);
    drain(prediction());

    renderer.render({
      meta: { ...makeMeta(), dirty: 'partial' },
      rows: [],
      cellDimensions: CELL,
      scrollDelta: 1,
    });
    renderFrame(renderer);
    expect(drain(prediction())).toEqual([]);

    renderFrame(renderer, { colors: { background: { r: 10, g: 20, b: 30 } } });
    const recolored = drain(prediction());
    expect(recolored.some((op) => op.fillStyle === 'rgb(10 20 30)')).toBeTrue();

    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    renderFrame(renderer);
    const rescaled = drain(prediction());
    const texts = rescaled.filter((op) => op.type === 'fillText');
    expect(texts.map((op) => op.x)).toEqual([0, 2 * CELL.width]);
  });

  test('网格变化时 overlay 失效并被清掉', () => {
    const { renderer, prediction } = setup();
    renderFrame(renderer);
    renderer.setPredictionOverlay(OVERLAY);
    drain(prediction());

    renderFrame(renderer, { size: { cols: 6, rows: 4 } });
    expect(drain(prediction()).filter((op) => op.type === 'fillRect')).toEqual([]);

    renderFrame(renderer, { size: { cols: 6, rows: 4 } });
    expect(drain(prediction())).toEqual([]);
  });

  test('首帧之前设置的 overlay 在首帧落笔', () => {
    const { renderer, prediction } = setup();
    renderer.setPredictionOverlay(OVERLAY);
    expect(drain(prediction()).filter((op) => op.type === 'fillRect')).toEqual([]);

    renderFrame(renderer);
    expect(drain(prediction()).filter((op) => op.type === 'fillText')).toHaveLength(2);
  });

  test('dispose 后不再持有 overlay', () => {
    const { renderer, prediction } = setup();
    renderFrame(renderer);
    renderer.setPredictionOverlay(OVERLAY);
    renderer.dispose();
    drain(prediction());
    renderFrame(renderer);
    expect(drain(prediction()).some((op) => op.type === 'fillText')).toBeFalse();
  });
});

describe('光标覆盖', () => {
  const cursorFills = (ops: DrawOp[]) => ops.filter((op) => op.type === 'fillRect');

  test('overlay.cursor 非空时在该格落笔并擦掉真实光标；置空后回到真实位置', () => {
    const { renderer, cursorCanvas } = setup();
    renderFrame(renderer);
    drain(cursorCanvas);

    renderer.setPredictionOverlay({ cells: [], cursor: { row: 0, col: 3 } });
    const moved = drain(cursorCanvas);
    expect(moved[0]).toEqual({ type: 'clearRect', x: 10, y: 40, width: 10, height: 20 });
    expect(cursorFills(moved)).toEqual([
      { type: 'fillRect', x: 30, y: 0, width: 10, height: 20, fillStyle: 'rgb(255 0 0)' },
    ]);

    renderer.setPredictionOverlay(null);
    const restored = drain(cursorCanvas);
    expect(restored[0]).toEqual({ type: 'clearRect', x: 30, y: 0, width: 10, height: 20 });
    expect(cursorFills(restored)).toEqual([
      { type: 'fillRect', x: 10, y: 40, width: 10, height: 20, fillStyle: 'rgb(255 0 0)' },
    ]);
  });

  test('覆盖期间真实光标移动的落定帧不改变落笔位置，清除后落到最新真实位置', () => {
    const { renderer, cursorCanvas } = setup();
    renderFrame(renderer);
    renderer.setPredictionOverlay({ cells: [], cursor: { row: 0, col: 3 } });
    drain(cursorCanvas);

    renderFrame(renderer, { cursor: { x: 2, y: 1 } });
    expect(drain(cursorCanvas)).toEqual([]);

    renderer.setPredictionOverlay(null);
    expect(cursorFills(drain(cursorCanvas))).toEqual([
      { type: 'fillRect', x: 20, y: 20, width: 10, height: 20, fillStyle: 'rgb(255 0 0)' },
    ]);
  });

  test('未落定帧只挂起：覆盖清除时回到最近落定的真实光标，commit 之后才落到挂起位置', () => {
    const { renderer, cursorCanvas } = setup();
    renderFrame(renderer);
    renderer.setPredictionOverlay({ cells: [], cursor: { row: 0, col: 3 } });
    drain(cursorCanvas);

    renderFrame(renderer, { cursor: { x: 2, y: 1 }, cursorSettled: false });
    expect(drain(cursorCanvas)).toEqual([]);

    renderer.setPredictionOverlay(null);
    expect(cursorFills(drain(cursorCanvas))).toEqual([
      { type: 'fillRect', x: 10, y: 40, width: 10, height: 20, fillStyle: 'rgb(255 0 0)' },
    ]);

    renderer.commitCursor();
    expect(cursorFills(drain(cursorCanvas))).toEqual([
      { type: 'fillRect', x: 20, y: 20, width: 10, height: 20, fillStyle: 'rgb(255 0 0)' },
    ]);
  });

  test('相同覆盖位置重复设置不重画；越界位置被忽略', () => {
    const { renderer, cursorCanvas } = setup();
    renderFrame(renderer);
    renderer.setPredictionOverlay({ cells: [], cursor: { row: 0, col: 3 } });
    drain(cursorCanvas);

    renderer.setPredictionOverlay({ cells: [], cursor: { row: 0, col: 3 } });
    expect(drain(cursorCanvas)).toEqual([]);

    renderer.setPredictionOverlay({ cells: [], cursor: { row: 9, col: 9 } });
    expect(cursorFills(drain(cursorCanvas))).toEqual([
      { type: 'fillRect', x: 10, y: 40, width: 10, height: 20, fillStyle: 'rgb(255 0 0)' },
    ]);
  });

  test('覆盖沿用真实光标的形状，真实光标隐藏时覆盖仍可见', () => {
    const { renderer, cursorCanvas } = setup();
    renderFrame(renderer, { cursor: { style: 'bar' } });
    drain(cursorCanvas);

    renderer.setPredictionOverlay({ cells: [], cursor: { row: 0, col: 3 } });
    expect(cursorFills(drain(cursorCanvas))).toEqual([
      { type: 'fillRect', x: 30, y: 0, width: 2, height: 20, fillStyle: 'rgb(255 0 0)' },
    ]);

    renderFrame(renderer, { cursor: { style: 'bar', visible: false } });
    expect(drain(cursorCanvas)).toEqual([]);
  });

  test('首帧之前设置的覆盖在首帧落在覆盖位置', () => {
    const { renderer, cursorCanvas } = setup();
    renderer.setPredictionOverlay({ cells: [], cursor: { row: 1, col: 1 } });
    expect(drain(cursorCanvas)).toEqual([]);

    renderFrame(renderer);
    expect(cursorFills(drain(cursorCanvas))).toEqual([
      { type: 'fillRect', x: 10, y: 20, width: 10, height: 20, fillStyle: 'rgb(255 0 0)' },
    ]);
  });

  test('网格变化丢弃覆盖，光标回到真实位置', () => {
    const { renderer, cursorCanvas } = setup();
    renderFrame(renderer);
    renderer.setPredictionOverlay({ cells: [], cursor: { row: 0, col: 3 } });
    drain(cursorCanvas);

    renderFrame(renderer, { size: { cols: 6, rows: 4 } });
    expect(cursorFills(drain(cursorCanvas))).toEqual([
      { type: 'fillRect', x: 10, y: 40, width: 10, height: 20, fillStyle: 'rgb(255 0 0)' },
    ]);
  });
});
