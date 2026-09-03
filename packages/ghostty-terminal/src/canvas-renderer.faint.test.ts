// SGR 2（faint / dim）从内核一路验到 canvas 落笔：Claude Code 之类的 TUI 大量用 dim 画
// 提示与占位文本，渲染器一旦忽略 faint，这些文字就和正文一样亮。
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
const DEFAULT_FG = 'rgb(238 238 238)';
// TEST_THEME：前景 #eeeeee、背景 #111111、绿 #00aa00。faint = 与背景 50% 混合。
const FAINT_DEFAULT_FG = 'rgb(128 128 128)';
const GREEN = 'rgb(0 170 0)';
const FAINT_GREEN = 'rgb(9 94 9)';
const FAINT_INVERSE = 'rgb(128 128 128)';

type PaintedGlyph = { text: string; fill: string; font: string };

type Harness = {
  write: (data: string) => void;
  paint: () => PaintedGlyph[];
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
    paint: () => {
      updateRenderState(state, terminal);
      const snapshotRows = Array.from(iterateRows(state));
      const meta = readRenderSnapshotMeta(state);
      context.operations = [];
      renderer.render({ meta, rows: snapshotRows, cellDimensions: CELL });
      return context.operations
        .filter(
          (operation) => operation.type === 'fillText' && (operation.y as number) < CELL.height
        )
        .map((operation) => ({
          text: operation.text as string,
          fill: operation.fillStyle as string,
          font: operation.font as string,
        }));
    },
    dispose: () => {
      renderer.dispose();
      disposeRenderStateResources(state);
      bindings.freeTerminal(terminal);
    },
  };
}

describe('faint（SGR 2）按背景色减半', () => {
  test('缺省前景色：dim 文字与正文文字取不同的落笔色', async () => {
    const dom = installFakeDom();
    const harness = await createHarness(20, 4);

    try {
      harness.write('\x1b[H\x1b[2mab\x1b[0mcd');
      expect(harness.paint().map((glyph) => glyph.fill)).toEqual([
        FAINT_DEFAULT_FG,
        FAINT_DEFAULT_FG,
        DEFAULT_FG,
        DEFAULT_FG,
      ]);
    } finally {
      harness.dispose();
      dom.restore();
    }
  });

  test('调色板前景色：faint 朝该 cell 的背景混合，而非整体降亮', async () => {
    const dom = installFakeDom();
    const harness = await createHarness(20, 4);

    try {
      harness.write('\x1b[H\x1b[32mab\x1b[2mcd\x1b[0m');
      expect(harness.paint().map((glyph) => glyph.fill)).toEqual([
        GREEN,
        GREEN,
        FAINT_GREEN,
        FAINT_GREEN,
      ]);
    } finally {
      harness.dispose();
      dom.restore();
    }
  });

  test('inverse + faint：先换手前后景，再朝换手后的背景混合', async () => {
    const dom = installFakeDom();
    const harness = await createHarness(20, 4);

    try {
      harness.write('\x1b[H\x1b[7mab\x1b[2mcd\x1b[0m');
      const fills = harness.paint().map((glyph) => glyph.fill);
      // inverse 单独作用时前景是主题背景色；再叠 faint 后朝主题前景色混合一半。
      expect(fills).toEqual(['rgb(17 17 17)', 'rgb(17 17 17)', FAINT_INVERSE, FAINT_INVERSE]);
    } finally {
      harness.dispose();
      dom.restore();
    }
  });

  test('bold + faint：颜色变暗但字重仍是 700', async () => {
    const dom = installFakeDom();
    const harness = await createHarness(20, 4);

    try {
      harness.write('\x1b[H\x1b[1mab\x1b[2mcd\x1b[0m');
      const glyphs = harness.paint();
      expect(glyphs.map((glyph) => glyph.fill)).toEqual([
        DEFAULT_FG,
        DEFAULT_FG,
        FAINT_DEFAULT_FG,
        FAINT_DEFAULT_FG,
      ]);
      expect(glyphs.every((glyph) => glyph.font === '700 13px monospace')).toBe(true);
    } finally {
      harness.dispose();
      dom.restore();
    }
  });
});
