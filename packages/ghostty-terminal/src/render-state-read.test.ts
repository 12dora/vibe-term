import { describe, expect, test } from 'bun:test';
import { type GhosttyBindings, getGhosttyBindings } from './ghostty-wasm';
import {
  createRenderState,
  disposeRenderStateResources,
  iterateRows,
  updateRenderState,
} from './render-state';

function withExports(bindings: GhosttyBindings, exports: WebAssembly.Exports): GhosttyBindings {
  return new Proxy(bindings, {
    get(target, property) {
      if (property === 'exports') {
        return exports;
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as GhosttyBindings;
}

describe('render-state batch reads', () => {
  test('每个扫描 cell 各调用一次 row-cell 与 raw-cell get_multi', async () => {
    const real = await getGhosttyBindings();
    const terminal = real.createTerminal(8, 2, 20);
    let rowCellMultiCalls = 0;
    let rawCellMultiCalls = 0;
    const exports = {
      ...real.exports,
      ghostty_render_state_row_cells_get_multi: (
        ...args: Parameters<typeof real.exports.ghostty_render_state_row_cells_get_multi>
      ) => {
        rowCellMultiCalls += 1;
        return real.exports.ghostty_render_state_row_cells_get_multi(...args);
      },
      ghostty_cell_get_multi: (...args: Parameters<typeof real.exports.ghostty_cell_get_multi>) => {
        rawCellMultiCalls += 1;
        return real.exports.ghostty_cell_get_multi(...args);
      },
    };
    const bindings = withExports(real, exports);
    const state = createRenderState(bindings);

    try {
      bindings.writeVt(terminal, 'plain\x1b[31mred');
      updateRenderState(state, terminal);
      Array.from(iterateRows(state));
      expect(rowCellMultiCalls).toBe(16);
      expect(rawCellMultiCalls).toBe(16);

      updateRenderState(state, terminal);
      Array.from(iterateRows(state));
      expect(rowCellMultiCalls).toBe(16);
      expect(rawCellMultiCalls).toBe(16);
    } finally {
      disposeRenderStateResources(state);
      real.freeTerminal(terminal);
    }
  });

  test('缺失前景色时仍读取并保留背景色', async () => {
    const bindings = await getGhosttyBindings();
    const terminal = bindings.createTerminal(8, 1, 20);
    const state = createRenderState(bindings);

    try {
      bindings.writeVt(terminal, 'A\x1b[31mB\x1b[0;44mC\x1b[33mD');
      updateRenderState(state, terminal);
      const cells = Array.from(iterateRows(state))[0].cells;
      expect([cells[0].fgColor, cells[0].bgColor]).toEqual([null, null]);
      expect(cells[1].fgColor).not.toBeNull();
      expect(cells[1].bgColor).toBeNull();
      expect(cells[2].fgColor).toBeNull();
      expect(cells[2].bgColor).not.toBeNull();
      expect(cells[3].fgColor).not.toBeNull();
      expect(cells[3].bgColor).toBe(cells[2].bgColor);
    } finally {
      disposeRenderStateResources(state);
      bindings.freeTerminal(terminal);
    }
  });

  test('超过 64 个 codepoint 的 grapheme 在 memory.grow 后刷新 view', async () => {
    const real = await getGhosttyBindings();
    const terminal = real.createTerminal(4, 1, 20);
    const input = `e${'\u0301'.repeat(70)}`;
    let forcedGrowths = 0;
    const bindings = new Proxy(real, {
      get(target, property) {
        if (property === 'allocBytes') {
          return (size: number) => {
            if (size === 71 * 4) {
              target.exports.memory.grow(1);
              forcedGrowths += 1;
            }
            return target.allocBytes(size);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as GhosttyBindings;
    const state = createRenderState(bindings);

    try {
      bindings.writeVt(terminal, input);
      updateRenderState(state, terminal);
      const cell = Array.from(iterateRows(state))[0].cells[0];
      expect(forcedGrowths).toBe(1);
      expect(cell.codepoints).toHaveLength(71);
      expect(cell.text).toBe(input);
    } finally {
      disposeRenderStateResources(state);
      real.freeTerminal(terminal);
    }
  });

  test('get_multi 错误保留原读取项的异常语义', async () => {
    const real = await getGhosttyBindings();
    const terminal = real.createTerminal(4, 1, 20);
    const exports = {
      ...real.exports,
      ghostty_render_state_row_cells_get_multi: (
        _cells: number,
        _count: number,
        _keys: number,
        _values: number,
        written: number
      ) => {
        real.view().setUint32(written, 0, true);
        return -77;
      },
    };
    const bindings = withExports(real, exports);
    const state = createRenderState(bindings);

    try {
      updateRenderState(state, terminal);
      expect(() => Array.from(iterateRows(state))).toThrow(
        'ghostty u64 read failed with result -77'
      );
    } finally {
      disposeRenderStateResources(state);
      real.freeTerminal(terminal);
    }
  });

  test('raw-cell get_multi 错误按失败字段抛出', async () => {
    const real = await getGhosttyBindings();
    const terminal = real.createTerminal(4, 1, 20);
    const exports = {
      ...real.exports,
      ghostty_cell_get_multi: (
        _cell: bigint,
        _count: number,
        _keys: number,
        _values: number,
        written: number
      ) => {
        real.view().setUint32(written, 0, true);
        return -78;
      },
    };
    const bindings = withExports(real, exports);
    const state = createRenderState(bindings);

    try {
      updateRenderState(state, terminal);
      expect(() => Array.from(iterateRows(state))).toThrow(
        'ghostty enum read failed with result -78'
      );
    } finally {
      disposeRenderStateResources(state);
      real.freeTerminal(terminal);
    }
  });
});
