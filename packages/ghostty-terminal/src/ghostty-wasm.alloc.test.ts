// WASM 线性内存分配的失败路径：setTerminalTheme / formatViewport 在抛错时必须把已经
// 分配的结构体全部归还，否则每次失败都在 wasm heap 上留下永久碎片。
// 用带记账的假 exports + 假 layout 直接驱动 GhosttyBindings，断言「未释放分配数 == 0」。
import { describe, expect, test } from 'bun:test';
import { GhosttyBindings } from './ghostty-wasm';
import type { GhosttyTheme } from './types';

type BindingsCtor = ConstructorParameters<typeof GhosttyBindings>;
type FakeExports = BindingsCtor[0];
type FakeLayout = BindingsCtor[1];

const U8 = { size: 1, type: 'u8' } as const;
const U32 = { size: 4, type: 'u32' } as const;
const BOOL = { size: 1, type: 'bool' } as const;
const USIZE = { size: 4, type: 'usize' } as const;

function makeType(
  size: number,
  fields: Record<string, { offset: number; size: number; type: string }>
) {
  return { size, align: 4, fields };
}

const LAYOUT = {
  GhosttyColorRgb: makeType(3, {
    r: { offset: 0, ...U8 },
    g: { offset: 1, ...U8 },
    b: { offset: 2, ...U8 },
  }),
  GhosttyPointCoordinate: makeType(8, {
    x: { offset: 0, ...U32 },
    y: { offset: 4, ...U32 },
  }),
  GhosttyPoint: makeType(16, {
    tag: { offset: 0, ...U32 },
    value: { offset: 8, size: 8, type: 'struct' },
  }),
  GhosttyGridRef: makeType(8, {
    raw: { offset: 0, size: 8, type: 'u64' },
  }),
  GhosttySelection: makeType(24, {
    size: { offset: 0, ...USIZE },
    rectangle: { offset: 4, ...BOOL },
    start: { offset: 8, size: 8, type: 'struct' },
    end: { offset: 16, size: 8, type: 'struct' },
  }),
  GhosttyFormatterScreenExtra: makeType(8, {
    size: { offset: 0, ...USIZE },
  }),
  GhosttyFormatterTerminalExtra: makeType(24, {
    size: { offset: 0, ...USIZE },
    palette: { offset: 4, ...BOOL },
    screen: { offset: 8, size: 8, type: 'struct' },
  }),
  GhosttyFormatterTerminalOptions: makeType(48, {
    size: { offset: 0, ...USIZE },
    emit: { offset: 4, ...U32 },
    unwrap: { offset: 8, ...BOOL },
    trim: { offset: 9, ...BOOL },
    selection: { offset: 12, ...U32 },
    extra: { offset: 16, size: 24, type: 'struct' },
  }),
} satisfies Record<string, unknown>;

type FakeOptions = {
  terminalSetResult?: number;
  formatterNewResult?: number;
};

function createTrackedBindings(options: FakeOptions = {}) {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const live = new Map<number, { kind: string; len: number }>();
  let next = 64;

  const alloc = (kind: string, len: number): number => {
    const ptr = next;
    next += Math.max(8, Math.ceil(len / 8) * 8);
    live.set(ptr, { kind, len });
    return ptr;
  };
  const free = (kind: string, ptr: number, len?: number): void => {
    const entry = live.get(ptr);
    if (!entry) {
      throw new Error(`double free or unknown ptr ${ptr} (${kind})`);
    }
    if (entry.kind !== kind || (len !== undefined && entry.len !== len)) {
      throw new Error(
        `free mismatch at ${ptr}: allocated ${entry.kind}/${entry.len}, freed ${kind}/${len}`
      );
    }
    live.delete(ptr);
  };

  const exports = {
    memory,
    ghostty_wasm_alloc_u8_array: (len: number) => alloc('u8array', len),
    ghostty_wasm_free_u8_array: (ptr: number, len: number) => free('u8array', ptr, len),
    ghostty_wasm_alloc_opaque: () => alloc('opaque', 4),
    ghostty_wasm_free_opaque: (ptr: number) => free('opaque', ptr),
    ghostty_wasm_alloc_u8: () => alloc('u8', 1),
    ghostty_wasm_free_u8: (ptr: number) => free('u8', ptr),
    ghostty_wasm_alloc_usize: () => alloc('usize', 4),
    ghostty_wasm_free_usize: (ptr: number) => free('usize', ptr),
    ghostty_terminal_set: () => options.terminalSetResult ?? 0,
    ghostty_terminal_get: (_terminal: number, data: number, outPtr: number) => {
      new DataView(memory.buffer).setUint16(outPtr, data === 1 ? 80 : 24, true);
      return 0;
    },
    ghostty_terminal_grid_ref: () => 0,
    ghostty_formatter_terminal_new: (_allocatorPtr: number, outFormatterPtr: number) => {
      const result = options.formatterNewResult ?? 0;
      if (result === 0) {
        // formatter 句柄同样走记账：否则漏调 freeFormatter 也不会被记账断言发现。
        new DataView(memory.buffer).setUint32(outFormatterPtr, alloc('formatter', 8), true);
      }
      return result;
    },
    ghostty_formatter_free: (formatter: number) => free('formatter', formatter),
    ghostty_formatter_format_alloc: (
      _formatter: number,
      _allocatorPtr: number,
      outPtrPtr: number,
      outLenPtr: number
    ) => {
      const view = new DataView(memory.buffer);
      view.setUint32(outPtrPtr, 0, true);
      view.setUint32(outLenPtr, 0, true);
      return 0;
    },
  } as unknown as FakeExports;

  return {
    bindings: new GhosttyBindings(exports, LAYOUT as unknown as FakeLayout),
    liveAllocations: live,
  };
}

const THEME: GhosttyTheme = {
  background: '#111111',
  foreground: '#eeeeee',
  cursor: '#ffffff',
  selectionBackground: '#334455',
  black: '#000000',
  red: '#aa0000',
  green: '#00aa00',
  yellow: '#aa5500',
  blue: '#0000aa',
  magenta: '#aa00aa',
  cyan: '#00aaaa',
  white: '#aaaaaa',
  brightBlack: '#555555',
  brightRed: '#ff5555',
  brightGreen: '#55ff55',
  brightYellow: '#ffff55',
  brightBlue: '#5555ff',
  brightMagenta: '#ff55ff',
  brightCyan: '#55ffff',
  brightWhite: '#ffffff',
};

describe('setTerminalTheme 分配记账', () => {
  test('正常路径释放全部分配', () => {
    const { bindings, liveAllocations } = createTrackedBindings();
    bindings.setTerminalTheme(1, THEME);
    expect(liveAllocations.size).toBe(0);
  });

  test('cursor 颜色非法（parseHexRgb 抛错）仍释放 fg/bg/cursor/palette', () => {
    const { bindings, liveAllocations } = createTrackedBindings();

    expect(() => bindings.setTerminalTheme(1, { ...THEME, cursor: 'not-a-color' })).toThrow(
      'expected #RRGGBB color'
    );
    expect(liveAllocations.size).toBe(0);
  });

  test('palette 基色非法（在 palette 分配之前抛错）不泄漏已分配的三个结构体', () => {
    const { bindings, liveAllocations } = createTrackedBindings();

    expect(() => bindings.setTerminalTheme(1, { ...THEME, brightCyan: '#zz' })).toThrow(
      'expected #RRGGBB color'
    );
    expect(liveAllocations.size).toBe(0);
  });

  test('ghostty_terminal_set 失败时也释放全部分配', () => {
    const { bindings, liveAllocations } = createTrackedBindings({ terminalSetResult: -2 });

    expect(() => bindings.setTerminalTheme(1, THEME)).toThrow('ghostty_terminal_set(foreground)');
    expect(liveAllocations.size).toBe(0);
  });
});

describe('formatViewport 分配记账', () => {
  const FORMAT_OPTIONS = { trim: true, unwrap: false, includePalette: false };

  test('正常路径释放 selection 与 formatter 的全部分配', () => {
    const { bindings, liveAllocations } = createTrackedBindings();

    expect(bindings.formatViewport(1, 0, FORMAT_OPTIONS, { cols: 80, rows: 24 })).toBe('');
    expect(liveAllocations.size).toBe(0);
  });

  test('createFormatter 抛错时 selection 仍被释放', () => {
    const { bindings, liveAllocations } = createTrackedBindings({ formatterNewResult: -2 });

    expect(() => bindings.formatViewport(1, 0, FORMAT_OPTIONS, { cols: 80, rows: 24 })).toThrow(
      'ghostty_formatter_terminal_new'
    );
    expect(liveAllocations.size).toBe(0);
  });
});
