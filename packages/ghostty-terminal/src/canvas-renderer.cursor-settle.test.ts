// 光标层抖动回归：TUI 以 10–30Hz 重绘时，一次整屏重绘的字节会分多个 write 到达
// （websocket / tmux %output 分片），rAF 到点渲染就会把「刚写完的那个字符后面那一格」
// 当成光标落点画上去，下一帧再挪回应用真正的落点——光标按输出频率在两格之间来回跳。
// 这里用真实 wasm + 真实 CanvasRenderer 驱动协调器，数光标层的落笔次数。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CanvasRenderer } from './canvas-renderer';
import { type GhosttyBindings, getGhosttyBindings } from './ghostty-wasm';
import { createRenderState, disposeRenderStateResources } from './render-state';
import { TerminalRenderCoordinator } from './terminal-render-coordinator';
import type { GhosttyCellDimensions } from './types';

type DrawOp = { type: string; x: number; y: number; width: number; height: number };

const CELL: GhosttyCellDimensions = { width: 10, height: 20 };
const COLS = 80;
const ROWS = 24;
const APP_FRAMES = 40; // 20Hz × 2s
const RAF_PER_APP_FRAME = 3; // 每个应用帧内过 3 次 rAF（60Hz 对 20Hz）

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
    this.ops.push({ type: 'fillRect', x, y, width, height });
  }
  fillText(): void {}
  strokeRect(x: number, y: number, width: number, height: number): void {
    this.ops.push({ type: 'strokeRect', x, y, width, height });
  }
  setLineDash(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  stroke(): void {}
  measureText(): {
    fontBoundingBoxAscent: number;
    fontBoundingBoxDescent: number;
    actualBoundingBoxAscent: number;
    actualBoundingBoxDescent: number;
    width: number;
  } {
    const px = Number.parseFloat(this.font) || 13;
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

let bindings: GhosttyBindings;
let previousDpr: unknown;
let previousDocument: unknown;
let previousRaf: unknown;
let previousCancelRaf: unknown;
let rafQueue: Array<() => void> = [];

function runFrame(): void {
  const queue = rafQueue;
  rafQueue = [];
  for (const callback of queue) {
    callback();
  }
}

interface Harness {
  write(data: string): void;
  frame(): void;
  cursorPaints(): number;
  cursorCells(): string[];
  forceFullRepaint(): void;
  dispose(): void;
}

function createHarness(): Harness {
  const created: FakeCanvas[] = [];
  (globalThis as { document?: unknown }).document = {
    createElement: () => {
      const canvas = new FakeCanvas();
      created.push(canvas);
      return canvas;
    },
  };

  const terminal = bindings.createTerminal(COLS, ROWS, 1000);
  const renderState = createRenderState(bindings);
  const renderer = new CanvasRenderer({
    screenElement: new FakeScreen() as unknown as HTMLElement,
    theme: { selectionBackground: 'rgba(0,0,0,0.3)' } as never,
    fontFamily: 'monospace',
    fontSize: 13,
  });
  // 构造顺序：main / link / selection / cursor
  const cursorCanvas = created[3];
  const coordinator = new TerminalRenderCoordinator(bindings, terminal, renderState, {
    cellDimensions: () => CELL,
    screenBounds: () => ({ left: 0, top: 0 }),
    viewportCols: () => COLS,
    viewportRows: () => ROWS,
    selectionRects: () => [],
    selectionText: () => null,
    selectionColor: () => 'rgba(0,0,0,0.3)',
    fileLinkContext: () => null,
    onSnapshot: () => {},
    onSelectionText: () => {},
  });
  coordinator.attach(renderer);

  return {
    write(data: string): void {
      bindings.writeVt(terminal, data);
      coordinator.scheduleFromOutput();
    },
    frame(): void {
      runFrame();
    },
    cursorPaints(): number {
      return cursorCanvas.ctx.ops.filter((op) => op.type !== 'clearRect').length;
    },
    cursorCells(): string[] {
      return cursorCanvas.ctx.ops
        .filter((op) => op.type !== 'clearRect')
        .map((op) => `${op.x / CELL.width},${op.y / CELL.height}`);
    },
    forceFullRepaint(): void {
      coordinator.forceFullRepaint();
    },
    dispose(): void {
      coordinator.dispose();
      disposeRenderStateResources(renderState);
      bindings.freeTerminal(terminal);
    },
  };
}

// 一个应用帧分两块字节到达，中间被一次 rAF 打断：第一块写完时笔尖停在
// 「12 s」的 s 后面那一格，第二块才把光标带到应用真正的落点（输入行）。
function writeAppFrame(harness: Harness, seconds: number): void {
  harness.write(`\x1b[H\x1b[J✻ Thinking… (${seconds} s`);
  harness.frame();
  harness.write(')\r\n> ');
  for (let i = 1; i < RAF_PER_APP_FRAME; i += 1) {
    harness.frame();
  }
}

beforeEach(async () => {
  bindings = await getGhosttyBindings();
  previousDpr = (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio;
  previousDocument = (globalThis as { document?: unknown }).document;
  previousRaf = globalThis.requestAnimationFrame;
  previousCancelRaf = globalThis.cancelAnimationFrame;
  (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 1;
  rafQueue = [];
  globalThis.requestAnimationFrame = ((callback: () => void) => {
    rafQueue.push(callback);
    return rafQueue.length;
  }) as unknown as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as unknown as typeof globalThis.cancelAnimationFrame;
});

afterEach(() => {
  (globalThis as { devicePixelRatio?: unknown }).devicePixelRatio = previousDpr;
  (globalThis as { document?: unknown }).document = previousDocument;
  globalThis.requestAnimationFrame = previousRaf as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = previousCancelRaf as typeof globalThis.cancelAnimationFrame;
});

describe('光标层只在输出静默后落笔', () => {
  test('20Hz 重绘 2 秒：光标落笔次数与闪烁节律同量级，不随输出帧率走', () => {
    const harness = createHarness();
    try {
      // 先跑一个应用帧让首支光标落到应用的最终落点，再开始计数
      writeAppFrame(harness, 10);
      harness.frame();
      const settled = harness.cursorPaints();

      for (let i = 1; i < APP_FRAMES; i += 1) {
        writeAppFrame(harness, 10 + i);
      }

      // 修复前：每个应用帧都会在「s 后面那一格」与输入行之间各落笔一次（80 次）。
      expect(harness.cursorPaints() - settled).toBeLessThanOrEqual(1);
      // 落笔位置只能是应用这一帧的最终落点（输入行的 "> " 后面，第 2 列第 1 行）。
      expect(harness.cursorCells().slice(settled - 1)).toEqual(['2,1']);
    } finally {
      harness.dispose();
    }
  });

  test('每帧 hide/show（ratatui 语义）不会把光标层清空一帧', () => {
    const harness = createHarness();
    try {
      harness.write('\x1b[?25h');
      harness.frame();
      const initial = harness.cursorPaints();

      for (let i = 0; i < APP_FRAMES; i += 1) {
        harness.write(`\x1b[?25l\x1b[H\x1b[J✻ Thinking… (${10 + i} s`);
        harness.frame();
        harness.write(')\r\n> \x1b[?25h');
        for (let j = 1; j < RAF_PER_APP_FRAME; j += 1) {
          harness.frame();
        }
      }

      // 修复前：中途那一帧读到 DECTCEM=隐藏，光标层被清空，下一帧再画回来（40 次闪）。
      expect(harness.cursorPaints() - initial).toBeLessThanOrEqual(2);
    } finally {
      harness.dispose();
    }
  });

  test('输出静默后光标落到应用真正的位置', () => {
    const harness = createHarness();
    try {
      writeAppFrame(harness, 12);
      harness.frame();

      expect(harness.cursorCells().at(-1)).toBe('2,1');
    } finally {
      harness.dispose();
    }
  });

  test('forceFullRepaint（tab 切回 / DOM 重插入）立刻按当刻状态落笔，不等静默', () => {
    const harness = createHarness();
    try {
      writeAppFrame(harness, 12);
      harness.frame();
      const before = harness.cursorPaints();

      harness.write('\x1b[10;5H');
      harness.forceFullRepaint();

      expect(harness.cursorPaints()).toBeGreaterThan(before);
      expect(harness.cursorCells().at(-1)).toBe('4,9');
    } finally {
      harness.dispose();
    }
  });
});
