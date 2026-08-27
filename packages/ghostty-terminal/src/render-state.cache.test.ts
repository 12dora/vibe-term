// render-state 的跨帧缓存：调色板按 colors 结构体字节比对失效，行按逐 cell 比对复用。
// 内核在当前 ghostty 构建里把每一行恒报为 dirty（见 bench/render-bridge.bench.ts），
// 因此「哪些行真的要重画」完全由这里的比对决定，钉住其失效条件。
import { describe, expect, test } from 'bun:test';
import { type GhosttyBindings, getGhosttyBindings } from './ghostty-wasm';
import {
  type GhosttyRenderStateResources,
  createRenderState,
  disposeRenderStateResources,
  iterateRows,
  readRenderSnapshotMeta,
  updateRenderState,
} from './render-state';
import type { GhosttyRenderRow, GhosttyTheme } from './types';

const THEME_DARK: GhosttyTheme = {
  background: '#111111',
  foreground: '#eeeeee',
  cursor: '#eeeeee',
  selectionBackground: 'rgba(120,120,120,0.4)',
  black: '#000000',
  red: '#cc6666',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#b294bb',
  cyan: '#8abeb7',
  white: '#c5c8c6',
  brightBlack: '#666666',
  brightRed: '#d54e53',
  brightGreen: '#b9ca4a',
  brightYellow: '#e7c547',
  brightBlue: '#7aa6da',
  brightMagenta: '#c397d8',
  brightCyan: '#70c0b1',
  brightWhite: '#eaeaea',
};

const THEME_LIGHT: GhosttyTheme = {
  ...THEME_DARK,
  background: '#fafafa',
  foreground: '#202020',
  red: '#aa0000',
};

type Harness = {
  bindings: GhosttyBindings;
  terminal: number;
  renderState: GhosttyRenderStateResources;
  frame: () => { rows: GhosttyRenderRow[]; meta: ReturnType<typeof readRenderSnapshotMeta> };
  dispose: () => void;
};

async function createHarness(cols = 20, rows = 6): Promise<Harness> {
  const bindings = await getGhosttyBindings();
  const terminal = bindings.createTerminal(cols, rows, 500);
  bindings.setTerminalTheme(terminal, THEME_DARK);
  const renderState = createRenderState(bindings);

  return {
    bindings,
    terminal,
    renderState,
    // 与 TerminalRenderCoordinator 同序：先完整迭代行，再读 meta（dirty 降级发生在迭代结束）。
    frame: () => {
      updateRenderState(renderState, terminal);
      const frameRows = Array.from(iterateRows(renderState));
      return { rows: frameRows, meta: readRenderSnapshotMeta(renderState) };
    },
    dispose: () => {
      disposeRenderStateResources(renderState);
      bindings.freeTerminal(terminal);
    },
  };
}

describe('render-state 跨帧缓存', () => {
  test('无输入的第二帧：行对象整体复用，dirty 由 full 降级为 clean', async () => {
    const harness = await createHarness();
    try {
      harness.bindings.writeVt(harness.terminal, 'hello\r\nworld');

      const first = harness.frame();
      expect(first.meta.dirty).toBe('full');
      expect(first.rows.every((row) => row.dirty)).toBeTrue();

      const second = harness.frame();
      expect(second.meta.dirty).toBe('clean');
      expect(second.rows.every((row) => !row.dirty)).toBeTrue();
      for (let index = 0; index < second.rows.length; index += 1) {
        expect(second.rows[index].cells).toBe(first.rows[index].cells);
      }
    } finally {
      harness.dispose();
    }
  });

  test('写入只让被改的行失效，其余行的 cells 数组保持同一实例', async () => {
    const harness = await createHarness();
    try {
      harness.bindings.writeVt(harness.terminal, 'alpha\r\nbeta\r\ngamma');
      harness.frame();
      const settled = harness.frame();

      harness.bindings.writeVt(harness.terminal, '\x1b[1;1HZ');
      const after = harness.frame();

      expect(after.meta.dirty).toBe('partial');
      expect(after.rows[0].dirty).toBeTrue();
      expect(after.rows[0].cells).not.toBe(settled.rows[0].cells);
      expect(after.rows[0].text.startsWith('Z')).toBeTrue();
      for (let index = 1; index < after.rows.length; index += 1) {
        expect(after.rows[index].dirty).toBeFalse();
        expect(after.rows[index].cells).toBe(settled.rows[index].cells);
      }
    } finally {
      harness.dispose();
    }
  });

  test('同一 snapshotVersion 内重复迭代返回同一批行，不重复读 WASM', async () => {
    const harness = await createHarness();
    try {
      harness.bindings.writeVt(harness.terminal, 'stable');
      harness.frame();

      updateRenderState(harness.renderState, harness.terminal);
      const first = Array.from(iterateRows(harness.renderState));
      const second = Array.from(iterateRows(harness.renderState));
      expect(second).toEqual(first);
      for (let index = 0; index < first.length; index += 1) {
        expect(second[index]).toBe(first[index]);
      }
    } finally {
      harness.dispose();
    }
  });

  test('主题切换刷新调色板：palette 实例换新且不降级 dirty', async () => {
    const harness = await createHarness();
    try {
      harness.bindings.writeVt(harness.terminal, 'themed');
      const first = harness.frame();
      const stable = harness.frame();
      expect(stable.meta.colors.palette).toBe(first.meta.colors.palette);
      expect(stable.meta.colors.background).toEqual({ r: 17, g: 17, b: 17 });

      harness.bindings.setTerminalTheme(harness.terminal, THEME_LIGHT);
      const themed = harness.frame();

      expect(themed.meta.colors.palette).not.toBe(first.meta.colors.palette);
      expect(themed.meta.colors.background).toEqual({ r: 250, g: 250, b: 250 });
      expect(themed.meta.colors.foreground).toEqual({ r: 32, g: 32, b: 32 });
      expect(themed.meta.colors.palette[1]).toEqual({ r: 170, g: 0, b: 0 });
      // 配色变了 → 所有 cell 的着色都可能变，本帧必须全画。
      expect(themed.meta.dirty).toBe('full');
      expect(themed.rows.every((row) => row.dirty)).toBeTrue();
    } finally {
      harness.dispose();
    }
  });

  test('resize 让整屏行缓存失效（几何不可比）', async () => {
    const harness = await createHarness();
    try {
      harness.bindings.writeVt(harness.terminal, 'resize me');
      harness.frame();
      const settled = harness.frame();
      expect(settled.meta.dirty).toBe('clean');

      harness.bindings.resizeTerminal(harness.terminal, 40, 6, { width: 8, height: 16 });
      const resized = harness.frame();

      expect(resized.meta.cols).toBe(40);
      expect(resized.meta.dirty).toBe('full');
      expect(resized.rows.every((row) => row.dirty)).toBeTrue();
      expect(resized.rows[0].cells).not.toBe(settled.rows[0].cells);
    } finally {
      harness.dispose();
    }
  });

  test('滚动视口让被移动的行重新变脏', async () => {
    const harness = await createHarness(20, 4);
    try {
      for (let index = 0; index < 12; index += 1) {
        harness.bindings.writeVt(harness.terminal, `line-${index}\r\n`);
      }
      harness.frame();
      const settled = harness.frame();
      expect(settled.meta.dirty).toBe('clean');

      harness.bindings.scrollViewportTop(harness.terminal);
      const scrolled = harness.frame();

      expect(scrolled.meta.dirty).not.toBe('clean');
      expect(scrolled.rows.some((row) => row.dirty)).toBeTrue();
      expect(scrolled.rows[0].text.startsWith('line-0')).toBeTrue();
    } finally {
      harness.dispose();
    }
  });

  test('内插：相同 style / 相同颜色的 cell 复用同一实例', async () => {
    const harness = await createHarness();
    try {
      harness.bindings.writeVt(harness.terminal, '\x1b[1;31mAAA\x1b[0m');
      const { rows } = harness.frame();
      const cells = rows[0].cells;

      expect(cells[0].style).toBe(cells[1].style);
      expect(cells[1].style).toBe(cells[2].style);
      expect(cells[0].style.bold).toBeTrue();
      expect(cells[0].fgColor).toBe(cells[2].fgColor);
      expect(cells[0].fgColor).toEqual({ r: 204, g: 102, b: 102 });
      // 空 cell 的 codepoints 复用同一个只读空数组
      expect(cells[10].codepoints).toBe(cells[11].codepoints);
    } finally {
      harness.dispose();
    }
  });
});
