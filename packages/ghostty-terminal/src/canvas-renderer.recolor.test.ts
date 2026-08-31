// 「同字形换色」回归：TUI（如 Claude Code）在 CJK 输入提交时会原位重画整行，字形一模一样、
// 只有 SGR 前景色变了。round 6 的行 dirty「消费即清 + 只画脏行」一旦把这类改动判成未变，
// 屏幕上那几个字就会卡在旧色里，直到别的操作把该行重新标脏——正是「文字莫名变绿」的形态。
// 这里从内核一路验到 canvas 落笔指令：行必须被标脏，且 fillText 必须用新颜色重画。
import { describe, expect, test } from 'bun:test';
import { CanvasRenderer } from './canvas-renderer';
import { getGhosttyBindings } from './ghostty-wasm';
import {
  createRenderState,
  disposeRenderStateResources,
  iterateRows,
  readRenderSnapshotMeta,
  updateRenderState,
} from './render-state';
import { type FakeCanvasContext2D, TEST_THEME, installFakeDom } from './test-support/fake-dom';

const CELL = { width: 8, height: 16 };
const GREEN = 'rgb(0 170 0)';
const DEFAULT_FG = 'rgb(238 238 238)';

type PaintedGlyph = { text: string; fill: string; row: number };

type Harness = {
  write: (data: string) => void;
  frame: () => { rowDirty: boolean; dirty: string; glyphs: PaintedGlyph[] };
  dispose: () => void;
};

async function createHarness(cols: number, rows: number): Promise<Harness> {
  const bindings = await getGhosttyBindings();
  const terminal = bindings.createTerminal(cols, rows, 200);
  bindings.setTerminalTheme(terminal, TEST_THEME);
  const state = createRenderState(bindings);
  const screenElement = document.createElement('div');
  const renderer = new CanvasRenderer({
    screenElement,
    theme: TEST_THEME,
    fontFamily: 'monospace',
    fontSize: 13,
  });
  const context = (screenElement.children[0] as unknown as { context: FakeCanvasContext2D })
    .context;

  return {
    write: (data) => {
      bindings.writeVt(terminal, data);
    },
    frame: () => {
      updateRenderState(state, terminal);
      const snapshotRows = Array.from(iterateRows(state));
      const meta = readRenderSnapshotMeta(state);
      context.operations = [];
      renderer.render({ meta, rows: snapshotRows, cellDimensions: CELL });
      const glyphs = context.operations
        .filter((op) => op.type === 'fillText')
        .map((op) => ({
          text: op.text as string,
          fill: op.fillStyle as string,
          row: Math.floor((op.y as number) / CELL.height),
        }));
      return { rowDirty: snapshotRows[0].dirty, dirty: meta.dirty, glyphs };
    },
    dispose: () => {
      disposeRenderStateResources(state);
      bindings.freeTerminal(terminal);
    },
  };
}

function fillsOnFirstRow(glyphs: PaintedGlyph[]): string[] {
  return glyphs.filter((glyph) => glyph.row === 0).map((glyph) => glyph.fill);
}

describe('同字形换色必须重画', () => {
  test('ASCII：原位把绿色 abc 改回默认色', async () => {
    const dom = installFakeDom();
    const harness = await createHarness(20, 4);

    try {
      harness.write('\x1b[H\x1b[32mabc\x1b[0m');
      expect(fillsOnFirstRow(harness.frame().glyphs)).toEqual([GREEN, GREEN, GREEN]);

      // 中间插一个空帧：让绿色那一版成为 previousRows 基线，逼出复用路径。
      expect(harness.frame().dirty).toBe('clean');

      harness.write('\x1b[H\x1b[0mabc');
      const repaint = harness.frame();
      expect(repaint.rowDirty).toBeTrue();
      expect(fillsOnFirstRow(repaint.glyphs)).toEqual([DEFAULT_FG, DEFAULT_FG, DEFAULT_FG]);
    } finally {
      harness.dispose();
      dom.restore();
    }
  });

  test('CJK 双宽：原位把绿色中文改回默认色', async () => {
    const dom = installFakeDom();
    const harness = await createHarness(20, 4);

    try {
      harness.write('\x1b[H\x1b[32m你好世界\x1b[0m');
      expect(fillsOnFirstRow(harness.frame().glyphs)).toEqual([GREEN, GREEN, GREEN, GREEN]);
      expect(harness.frame().dirty).toBe('clean');

      harness.write('\x1b[H\x1b[0m你好世界');
      const repaint = harness.frame();
      expect(repaint.rowDirty).toBeTrue();
      expect(fillsOnFirstRow(repaint.glyphs)).toEqual([
        DEFAULT_FG,
        DEFAULT_FG,
        DEFAULT_FG,
        DEFAULT_FG,
      ]);
    } finally {
      harness.dispose();
      dom.restore();
    }
  });

  test('CJK 逐字提交：每次整行重画都落到新颜色', async () => {
    const dom = installFakeDom();
    const harness = await createHarness(20, 4);

    try {
      let committed = '';
      for (const char of ['你', '好', '世', '界']) {
        committed += char;
        // 模拟 TUI 提交一个字后重画整行：先按中间态画成绿色，再改回默认色。
        harness.write(`\x1b[H\x1b[2K\x1b[32m${committed}\x1b[0m`);
        expect(fillsOnFirstRow(harness.frame().glyphs)).toEqual(Array.from(committed, () => GREEN));

        harness.write(`\x1b[H\x1b[2K\x1b[0m${committed}`);
        const repaint = harness.frame();
        expect(repaint.rowDirty).toBeTrue();
        expect(fillsOnFirstRow(repaint.glyphs)).toEqual(Array.from(committed, () => DEFAULT_FG));
      }
    } finally {
      harness.dispose();
      dom.restore();
    }
  });

  test('只改背景色：同字形同前景，背景改动也必须重画', async () => {
    const dom = installFakeDom();
    const harness = await createHarness(20, 4);

    try {
      harness.write('\x1b[H\x1b[42mabc\x1b[0m');
      harness.frame();
      expect(harness.frame().dirty).toBe('clean');

      harness.write('\x1b[H\x1b[0mabc');
      const repaint = harness.frame();
      expect(repaint.rowDirty).toBeTrue();
      expect(fillsOnFirstRow(repaint.glyphs)).toEqual([DEFAULT_FG, DEFAULT_FG, DEFAULT_FG]);
    } finally {
      harness.dispose();
      dom.restore();
    }
  });
});
