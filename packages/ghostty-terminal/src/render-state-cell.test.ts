// decodeRenderCell 的解码矩阵与分配记账：字素/宽度/样式/可选颜色都走 WASM 指针 ABI，
// 任一分支提前返回或抛错都必须把临时分配还回去。用带记账的假 exports 驱动真实 GhosttyBindings。
import { describe, expect, test } from 'bun:test';
import { GhosttyBindings } from './ghostty-wasm';
import { decodeRenderCell } from './render-state-cell';
import type { GhosttyRenderStateResources } from './render-state-reads';
import type { GhosttyCellWidthKind } from './types';

type FakeExports = ConstructorParameters<typeof GhosttyBindings>[0];
type PartialExports = Partial<FakeExports>;

const ROW_CELLS_RAW = 1;
const ROW_CELLS_STYLE = 2;
const ROW_CELLS_GRAPHEMES_LEN = 3;
const ROW_CELLS_GRAPHEMES_BUF = 4;
const ROW_CELLS_BG_COLOR = 5;
const ROW_CELLS_FG_COLOR = 6;
const CELL_WIDE = 3;
const CELL_HAS_TEXT = 4;

const LAYOUT = {
  GhosttyColorRgb: {
    size: 3,
    align: 1,
    fields: {
      r: { offset: 0, size: 1, type: 'u8' },
      g: { offset: 1, size: 1, type: 'u8' },
      b: { offset: 2, size: 1, type: 'u8' },
    },
  },
  GhosttyStyle: {
    size: 72,
    align: 8,
    fields: {
      size: { offset: 0, size: 4, type: 'u32' },
      bold: { offset: 56, size: 1, type: 'bool' },
      italic: { offset: 57, size: 1, type: 'bool' },
      faint: { offset: 58, size: 1, type: 'bool' },
      blink: { offset: 59, size: 1, type: 'bool' },
      inverse: { offset: 60, size: 1, type: 'bool' },
      invisible: { offset: 61, size: 1, type: 'bool' },
      strikethrough: { offset: 62, size: 1, type: 'bool' },
      overline: { offset: 63, size: 1, type: 'bool' },
      underline: { offset: 64, size: 4, type: 'i32' },
    },
  },
} satisfies Record<string, unknown>;

const STYLE_FLAGS = [
  'bold',
  'italic',
  'faint',
  'blink',
  'inverse',
  'invisible',
  'strikethrough',
  'overline',
] as const;

type StyleFlag = (typeof STYLE_FLAGS)[number];

type ColorFixture = { r: number; g: number; b: number } | { result: number };

type CellFixture = {
  raw: bigint;
  codepoints: number[];
  wide: number;
  hasText: boolean;
  flags: StyleFlag[];
  underline: number;
  fg: ColorFixture;
  bg: ColorFixture;
  graphemesLenResult: number | null;
};

const DEFAULT_FIXTURE: CellFixture = {
  raw: 0x1234n,
  codepoints: [0x41],
  wide: 0,
  hasText: true,
  flags: [],
  underline: 0,
  fg: { result: -2 },
  bg: { result: -2 },
  graphemesLenResult: null,
};

const ROW_CELLS_HANDLE = 77;

function createFakeCell(overrides: Partial<CellFixture> = {}) {
  const fixture: CellFixture = { ...DEFAULT_FIXTURE, ...overrides };
  const memory = new WebAssembly.Memory({ initial: 2 });
  const live = new Map<number, { kind: string; len: number }>();
  const rawCellArgs: bigint[] = [];
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

  const writeColor = (color: ColorFixture, outPtr: number): number => {
    if ('result' in color) {
      return color.result;
    }
    const view = new DataView(memory.buffer);
    view.setUint8(outPtr, color.r);
    view.setUint8(outPtr + 1, color.g);
    view.setUint8(outPtr + 2, color.b);
    return 0;
  };

  const writeStyle = (outPtr: number): number => {
    const view = new DataView(memory.buffer);
    for (const flag of STYLE_FLAGS) {
      view.setUint8(
        outPtr + LAYOUT.GhosttyStyle.fields[flag].offset,
        fixture.flags.includes(flag) ? 1 : 0
      );
    }
    view.setInt32(outPtr + LAYOUT.GhosttyStyle.fields.underline.offset, fixture.underline, true);
    return 0;
  };

  const exports: PartialExports = {
    memory,
    ghostty_wasm_alloc_u8_array: (len: number) => alloc('u8array', len),
    ghostty_wasm_free_u8_array: (ptr: number, len: number) => free('u8array', ptr, len),
    ghostty_wasm_alloc_u8: () => alloc('u8', 1),
    ghostty_wasm_free_u8: (ptr: number) => free('u8', ptr),
    ghostty_render_state_row_cells_get: (cells: number, data: number, outPtr: number): number => {
      expect(cells).toBe(ROW_CELLS_HANDLE);
      const view = new DataView(memory.buffer);
      switch (data) {
        case ROW_CELLS_RAW:
          view.setBigUint64(outPtr, fixture.raw, true);
          return 0;
        case ROW_CELLS_STYLE:
          return writeStyle(outPtr);
        case ROW_CELLS_GRAPHEMES_LEN:
          if (fixture.graphemesLenResult !== null) {
            return fixture.graphemesLenResult;
          }
          view.setUint32(outPtr, fixture.codepoints.length, true);
          return 0;
        case ROW_CELLS_GRAPHEMES_BUF:
          fixture.codepoints.forEach((codepoint, index) => {
            view.setUint32(outPtr + index * 4, codepoint, true);
          });
          return 0;
        case ROW_CELLS_FG_COLOR:
          return writeColor(fixture.fg, outPtr);
        case ROW_CELLS_BG_COLOR:
          return writeColor(fixture.bg, outPtr);
        default:
          throw new Error(`unexpected row cell data ${data}`);
      }
    },
    ghostty_cell_get: (cell: bigint, data: number, outPtr: number): number => {
      rawCellArgs.push(cell);
      const view = new DataView(memory.buffer);
      if (data === CELL_WIDE) {
        view.setInt32(outPtr, fixture.wide, true);
        return 0;
      }
      if (data === CELL_HAS_TEXT) {
        view.setUint8(outPtr, fixture.hasText ? 1 : 0);
        return 0;
      }
      throw new Error(`unexpected cell data ${data}`);
    },
  };

  const resources: GhosttyRenderStateResources = {
    bindings: new GhosttyBindings(exports as FakeExports, LAYOUT),
    renderStateHandle: 1,
    rowIteratorHandle: 2,
    rowCellsHandle: ROW_CELLS_HANDLE,
    snapshotVersion: 0,
    disposed: false,
    cachedMeta: null,
  };

  return { resources, liveAllocations: live, rawCellArgs };
}

describe('decodeRenderCell 解码矩阵', () => {
  test('完整解码字素、宽度、样式与前后景色', () => {
    const { resources, liveAllocations, rawCellArgs } = createFakeCell({
      codepoints: [0x1f468, 0x200d, 0x1f4bb],
      wide: 1,
      hasText: true,
      flags: ['bold', 'italic', 'strikethrough'],
      underline: 3,
      fg: { r: 10, g: 20, b: 30 },
      bg: { r: 40, g: 50, b: 60 },
    });

    expect(decodeRenderCell(resources, 5)).toEqual({
      x: 5,
      text: '\u{1f468}\u{200d}\u{1f4bb}',
      codepoints: [0x1f468, 0x200d, 0x1f4bb],
      widthKind: 'wide',
      hasText: true,
      style: {
        bold: true,
        italic: true,
        faint: false,
        blink: false,
        inverse: false,
        invisible: false,
        strikethrough: true,
        overline: false,
        underline: 3,
      },
      fgColor: { r: 10, g: 20, b: 30 },
      bgColor: { r: 40, g: 50, b: 60 },
    });
    expect(rawCellArgs).toEqual([0x1234n, 0x1234n]);
    expect(liveAllocations.size).toBe(0);
  });

  test('零字素时不分配字素缓冲且文本为空', () => {
    const { resources, liveAllocations } = createFakeCell({ codepoints: [], hasText: false });
    const cell = decodeRenderCell(resources, 0);

    expect(cell.codepoints).toEqual([]);
    expect(cell.text).toBe('');
    expect(cell.hasText).toBeFalse();
    expect(liveAllocations.size).toBe(0);
  });

  test('非法码位回退为空文本但保留原始码位', () => {
    const { resources, liveAllocations } = createFakeCell({ codepoints: [0x110000] });
    const cell = decodeRenderCell(resources, 0);

    expect(cell.text).toBe('');
    expect(cell.codepoints).toEqual([0x110000]);
    expect(liveAllocations.size).toBe(0);
  });

  const WIDTH_CASES: [number, GhosttyCellWidthKind][] = [
    [0, 'narrow'],
    [1, 'wide'],
    [2, 'spacer-tail'],
    [3, 'spacer-head'],
    [9, 'narrow'],
  ];

  test.each(WIDTH_CASES)('宽度枚举 %i 映射为 %s', (wide, expected) => {
    const { resources, liveAllocations } = createFakeCell({ wide });

    expect(decodeRenderCell(resources, 0).widthKind).toBe(expected);
    expect(liveAllocations.size).toBe(0);
  });

  test('颜色返回 GHOSTTY_INVALID_VALUE 时为 null', () => {
    const { resources, liveAllocations } = createFakeCell({
      fg: { result: -2 },
      bg: { result: -2 },
    });
    const cell = decodeRenderCell(resources, 0);

    expect(cell.fgColor).toBeNull();
    expect(cell.bgColor).toBeNull();
    expect(liveAllocations.size).toBe(0);
  });

  test('颜色读取返回其他错误码时抛错且不泄漏', () => {
    const { resources, liveAllocations } = createFakeCell({ fg: { result: -1 } });

    expect(() => decodeRenderCell(resources, 0)).toThrow(
      'ghostty optional color read failed with result -1'
    );
    expect(liveAllocations.size).toBe(0);
  });

  test('字素长度读取失败时抛错且不泄漏', () => {
    const { resources, liveAllocations } = createFakeCell({ graphemesLenResult: -2 });

    expect(() => decodeRenderCell(resources, 0)).toThrow('ghostty u32 read failed with result -2');
    expect(liveAllocations.size).toBe(0);
  });
});
