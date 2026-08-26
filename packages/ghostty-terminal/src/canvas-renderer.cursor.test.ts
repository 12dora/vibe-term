// 光标层渲染：四种 GhosttyCursorVisualStyle 必须画出各自的形状（此前无论哪种都只画
// 底部横条），且 cursor.blinking=false 时不得启动闪烁定时器。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CanvasRenderer } from './canvas-renderer';
import type {
  GhosttyCellDimensions,
  GhosttyCursorVisualStyle,
  GhosttyRenderSnapshotMeta,
  GhosttyTheme,
} from './types';

type DrawOp = {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fillStyle?: string;
  strokeStyle?: string;
  lineWidth?: number;
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
  fillText(text: string, x: number, y: number): void {
    this.ops.push({ type: 'fillText', x, y, width: 0, height: 0 });
    void text;
  }
  strokeRect(x: number, y: number, width: number, height: number): void {
    this.ops.push({
      type: 'strokeRect',
      x,
      y,
      width,
      height,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
    });
  }
  measureText(): {
    fontBoundingBoxAscent: number;
    fontBoundingBoxDescent: number;
    actualBoundingBoxAscent: number;
    actualBoundingBoxDescent: number;
    width: number;
  } {
    const px = Number.parseFloat(this.font) || FONT_SIZE;
    return {
      fontBoundingBoxAscent: px * 0.8,
      fontBoundingBoxDescent: px * 0.3,
      actualBoundingBoxAscent: px * 0.7,
      actualBoundingBoxDescent: px * 0.2,
      width: px * 0.6,
    };
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

function makeMeta(
  cursor: Partial<GhosttyRenderSnapshotMeta['cursor']> & { style: GhosttyCursorVisualStyle },
  cursorColor: GhosttyRenderSnapshotMeta['colors']['cursor'] = { r: 255, g: 0, b: 0 }
): GhosttyRenderSnapshotMeta {
  return {
    cols: 4,
    rows: 4,
    dirty: 'clean',
    colors: {
      background: { r: 0, g: 0, b: 0 },
      foreground: { r: 200, g: 200, b: 200 },
      cursor: cursorColor,
      palette: [],
    },
    cursor: {
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
let intervalCalls: number[];
let clearedIntervals: number[];

function setup(dpr = 1) {
  (globalThis as { devicePixelRatio?: number }).devicePixelRatio = dpr;
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
    theme: { selectionBackground: 'rgba(0,0,0,0.3)' } as unknown as GhosttyTheme,
    fontFamily: 'monospace',
    fontSize: FONT_SIZE,
  });

  // 构造顺序：main / link / selection / cursor
  return { renderer, cursorCanvas: created[3] };
}

function cursorOps(canvas: FakeCanvas): DrawOp[] {
  return canvas.ctx.ops.filter((op) => op.type !== 'clearRect');
}

beforeEach(() => {
  previousDpr = (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio;
  previousDocument = (globalThis as { document?: unknown }).document;
  previousSetInterval = globalThis.setInterval;
  previousClearInterval = globalThis.clearInterval;
  intervalCalls = [];
  clearedIntervals = [];
  let nextTimerId = 1;
  globalThis.setInterval = ((_handler: () => void, delay?: number) => {
    intervalCalls.push(delay ?? 0);
    nextTimerId += 1;
    return nextTimerId as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = ((id: number) => {
    clearedIntervals.push(id);
  }) as unknown as typeof globalThis.clearInterval;
});

afterEach(() => {
  (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio = previousDpr;
  (globalThis as { document?: unknown }).document = previousDocument;
  globalThis.setInterval = previousSetInterval;
  globalThis.clearInterval = previousClearInterval;
});

describe('drawCursor 按 cursor.style 画出对应形状', () => {
  test('bar：cell 左缘的细竖条，占满 cell 高', () => {
    const { renderer, cursorCanvas } = setup();
    renderer.render({ meta: makeMeta({ style: 'bar' }), rows: [], cellDimensions: CELL });

    expect(cursorOps(cursorCanvas)).toEqual([
      { type: 'fillRect', x: 10, y: 40, width: 2, height: 20, fillStyle: 'rgb(255 0 0)' },
    ]);
  });

  test('block：填满整个 cell', () => {
    const { renderer, cursorCanvas } = setup();
    renderer.render({ meta: makeMeta({ style: 'block' }), rows: [], cellDimensions: CELL });

    expect(cursorOps(cursorCanvas)).toEqual([
      { type: 'fillRect', x: 10, y: 40, width: 10, height: 20, fillStyle: 'rgb(255 0 0)' },
    ]);
  });

  test('underline：贴 cell 底缘的细横条', () => {
    const { renderer, cursorCanvas } = setup();
    renderer.render({ meta: makeMeta({ style: 'underline' }), rows: [], cellDimensions: CELL });

    expect(cursorOps(cursorCanvas)).toEqual([
      { type: 'fillRect', x: 10, y: 58, width: 9, height: 2, fillStyle: 'rgb(255 0 0)' },
    ]);
  });

  test('block-hollow：只描边不填充', () => {
    const { renderer, cursorCanvas } = setup();
    renderer.render({ meta: makeMeta({ style: 'block-hollow' }), rows: [], cellDimensions: CELL });

    const ops = cursorOps(cursorCanvas);
    expect(ops.some((op) => op.type === 'fillRect')).toBeFalse();
    expect(ops).toEqual([
      {
        type: 'strokeRect',
        x: 10.5,
        y: 40.5,
        width: 9,
        height: 19,
        strokeStyle: 'rgb(255 0 0)',
        lineWidth: 1,
      },
    ]);
  });

  test('wideTail 让 block 覆盖两个 cell 宽', () => {
    const { renderer, cursorCanvas } = setup();
    renderer.render({
      meta: makeMeta({ style: 'block', wideTail: true }),
      rows: [],
      cellDimensions: CELL,
    });

    expect(cursorOps(cursorCanvas)[0]?.width).toBe(20);
  });

  test('colors.cursor 为空时回落到 colors.foreground（颜色来源不变）', () => {
    const { renderer, cursorCanvas } = setup();
    renderer.render({
      meta: makeMeta({ style: 'block' }, null),
      rows: [],
      cellDimensions: CELL,
    });

    expect(cursorOps(cursorCanvas)[0]?.fillStyle).toBe('rgb(200 200 200)');
  });

  test('光标不可见时不画任何图形', () => {
    const { renderer, cursorCanvas } = setup();
    renderer.render({
      meta: makeMeta({ style: 'block', visible: false }),
      rows: [],
      cellDimensions: CELL,
    });

    expect(cursorOps(cursorCanvas)).toHaveLength(0);
  });
});

describe('drawCursor 遵循 cursor.blinking', () => {
  test('blinking=false 不启动定时器，光标层不透明度保持 1', () => {
    const { renderer, cursorCanvas } = setup();
    renderer.render({
      meta: makeMeta({ style: 'block', blinking: false }),
      rows: [],
      cellDimensions: CELL,
    });

    expect(intervalCalls).toHaveLength(0);
    expect(cursorCanvas.style.opacity).toBe('1');
  });

  test('blinking=true 启动定时器', () => {
    const { renderer } = setup();
    renderer.render({
      meta: makeMeta({ style: 'block', blinking: true }),
      rows: [],
      cellDimensions: CELL,
    });

    expect(intervalCalls).toHaveLength(1);
    renderer.dispose();
  });

  test('blinking 由 true 变 false 时停掉已有定时器', () => {
    const { renderer, cursorCanvas } = setup();
    renderer.render({
      meta: makeMeta({ style: 'block', blinking: true }),
      rows: [],
      cellDimensions: CELL,
    });
    expect(intervalCalls).toHaveLength(1);

    renderer.render({
      meta: makeMeta({ style: 'block', blinking: false }),
      rows: [],
      cellDimensions: CELL,
    });

    expect(clearedIntervals).toHaveLength(1);
    expect(cursorCanvas.style.opacity).toBe('1');
  });

  test('blinking 变化计入 lastCursor 差异检测（重绘旧光标所在行）', () => {
    const { renderer } = setup();
    renderer.render({
      meta: makeMeta({ style: 'block', blinking: true }),
      rows: [],
      cellDimensions: CELL,
    });

    renderer.render({
      meta: makeMeta({ style: 'block', blinking: false }),
      rows: [],
      cellDimensions: CELL,
    });

    expect(renderer.getDebugState().lastDrawnRows).toEqual([2]);
  });

  test('位置与 blinking 均未变时不重复标记旧行', () => {
    const { renderer } = setup();
    const meta = makeMeta({ style: 'block', blinking: true });
    renderer.render({ meta, rows: [], cellDimensions: CELL });
    renderer.render({ meta, rows: [], cellDimensions: CELL });

    expect(renderer.getDebugState().lastDrawnRows).toEqual([]);
    renderer.dispose();
  });
});
