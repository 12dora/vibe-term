// OSC 8 URI 读取包装：OUT_OF_SPACE 时按所需长度扩容重读、超长不读、grid_ref 失败返回 null，
// dispose 归还全部分配（记账假 exports）；再用真实 wasm 钉住「写 OSC 8 → 读回 URI」的协议前提。
import { describe, expect, test } from 'bun:test';
import {
  GhosttyHyperlinkReader,
  MAX_HYPERLINK_URI_BYTES,
  REJECTED_HYPERLINK_URI,
} from './ghostty-hyperlink';
import { GhosttyBindings, getGhosttyBindings } from './ghostty-wasm';

type BindingsCtor = ConstructorParameters<typeof GhosttyBindings>;

const U16 = { size: 2, type: 'u16' } as const;
const U32 = { size: 4, type: 'u32' } as const;

const LAYOUT = {
  GhosttyPoint: {
    size: 24,
    align: 8,
    fields: { tag: { offset: 0, ...U32 }, value: { offset: 8, size: 16, type: 'opaque' } },
  },
  GhosttyPointCoordinate: {
    size: 8,
    align: 4,
    fields: { x: { offset: 0, ...U16 }, y: { offset: 4, ...U32 } },
  },
  GhosttyGridRef: {
    size: 12,
    align: 4,
    fields: { size: { offset: 0, ...U32 }, node: { offset: 4, ...U32 }, x: { offset: 8, ...U16 } },
  },
};

const SUCCESS = 0;
const OUT_OF_SPACE = -3;

function createFakeBindings(uris: Record<string, string>, gridRefResult = SUCCESS) {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const live = new Map<number, number>();
  const uriCalls: number[] = [];
  let next = 64;
  const alloc = (len: number) => {
    const ptr = next;
    next += Math.max(8, Math.ceil(len / 8) * 8);
    live.set(ptr, len);
    return ptr;
  };
  const free = (ptr: number) => {
    if (!live.delete(ptr)) throw new Error(`double free ${ptr}`);
  };
  let lastPoint = '';
  let gridRefCalls = 0;
  const view = () => new DataView(memory.buffer);
  const exports = {
    memory,
    ghostty_wasm_alloc_u8_array: (len: number) => alloc(len),
    ghostty_wasm_free_u8_array: (ptr: number) => free(ptr),
    ghostty_wasm_alloc_usize: () => alloc(4),
    ghostty_wasm_free_usize: (ptr: number) => free(ptr),
    ghostty_terminal_grid_ref: (_terminal: number, point: number, ref: number) => {
      gridRefCalls += 1;
      expect(view().getUint32(point, true)).toBe(1);
      expect(view().getUint32(ref, true)).toBe(12);
      lastPoint = `${view().getUint16(point + 8, true)},${view().getUint32(point + 12, true)}`;
      return gridRefResult;
    },
    ghostty_grid_ref_hyperlink_uri: (_ref: number, buf: number, len: number, outLen: number) => {
      uriCalls.push(len);
      const encoded = new TextEncoder().encode(uris[lastPoint] ?? '');
      view().setUint32(outLen, encoded.length, true);
      if (encoded.length > len) return OUT_OF_SPACE;
      new Uint8Array(memory.buffer, buf, encoded.length).set(encoded);
      return SUCCESS;
    },
  } as unknown as BindingsCtor[0];
  const bindings = new GhosttyBindings(exports, LAYOUT as unknown as BindingsCtor[1]);
  return { bindings, live, uriCalls, gridRefCalls: () => gridRefCalls };
}

describe('GhosttyHyperlinkReader（假 exports）', () => {
  test('短 URI 一次读出；无链接返回 null', () => {
    const { bindings, uriCalls } = createFakeBindings({ '3,2': 'https://example.com/a' });
    const reader = new GhosttyHyperlinkReader(bindings, 1);
    expect(reader.uriAt(3, 2)).toBe('https://example.com/a');
    expect(reader.uriAt(0, 0)).toBeNull();
    expect(uriCalls).toHaveLength(2);
    reader.dispose();
  });

  test('OUT_OF_SPACE 按所需长度扩容后重读，之后复用大缓冲', () => {
    const long = `https://example.com/${'x'.repeat(600)}`;
    const { bindings, uriCalls } = createFakeBindings({ '1,0': long, '2,0': long });
    const reader = new GhosttyHyperlinkReader(bindings, 1);
    expect(reader.uriAt(1, 0)).toBe(long);
    expect(uriCalls).toEqual([256, long.length]);
    expect(reader.uriAt(2, 0)).toBe(long);
    expect(uriCalls).toEqual([256, long.length, long.length]);
    reader.dispose();
  });

  test('超过上限的 URI 不扩容，返回「被拒」而非「读不到」', () => {
    const huge = `https://e.com/${'y'.repeat(MAX_HYPERLINK_URI_BYTES)}`;
    const { bindings, uriCalls } = createFakeBindings({ '0,0': huge });
    const reader = new GhosttyHyperlinkReader(bindings, 1);
    expect(reader.uriAt(0, 0)).toBe(REJECTED_HYPERLINK_URI);
    expect(REJECTED_HYPERLINK_URI).toBe('');
    expect(uriCalls).toHaveLength(1);
    reader.dispose();
  });

  test('grid_ref 失败（坐标越界）返回 null 且不查 URI', () => {
    const { bindings, uriCalls } = createFakeBindings({}, -2);
    const reader = new GhosttyHyperlinkReader(bindings, 1);
    expect(reader.uriAt(0, 99)).toBeNull();
    expect(uriCalls).toHaveLength(0);
    reader.dispose();
  });

  test('dispose 归还所有分配，可重复调用；未使用时不分配', () => {
    const { bindings, live } = createFakeBindings({ '0,0': `https://e.com/${'z'.repeat(400)}` });
    const idle = new GhosttyHyperlinkReader(bindings, 1);
    idle.dispose();
    expect(live.size).toBe(0);

    const reader = new GhosttyHyperlinkReader(bindings, 1);
    reader.uriAt(0, 0);
    expect(live.size).toBeGreaterThan(0);
    reader.dispose();
    reader.dispose();
    expect(live.size).toBe(0);
  });
});

describe('GhosttyHyperlinkReader dispose 守卫', () => {
  test('dispose 之后 uriAt / viewport 不再分配、不再碰内核句柄', () => {
    const { bindings, live, uriCalls, gridRefCalls } = createFakeBindings({ '0,0': 'https://a' });
    const reader = new GhosttyHyperlinkReader(bindings, 1);
    expect(reader.uriAt(0, 0)).toBe('https://a');
    reader.dispose();

    expect(reader.uriAt(0, 0)).toBeNull();
    expect(reader.viewport()).toEqual({ offset: 0, rows: 0 });
    expect(live.size).toBe(0);
    expect(gridRefCalls()).toBe(1);
    expect(uriCalls).toHaveLength(1);
  });
});

describe('GhosttyHyperlinkReader（真实 wasm）', () => {
  test('viewport() 给出当前视口顶的绝对行号与视口行数', async () => {
    const bindings = await getGhosttyBindings();
    const terminal = bindings.createTerminal(20, 4, 100);
    const reader = new GhosttyHyperlinkReader(bindings, terminal);
    try {
      bindings.writeVt(terminal, Array.from({ length: 10 }, (_, i) => `l${i}`).join('\r\n'));
      expect(reader.viewport()).toEqual({ offset: 6, rows: 4 });
      bindings.scrollViewportTop(terminal);
      expect(reader.viewport()).toEqual({ offset: 0, rows: 4 });
    } finally {
      reader.dispose();
      bindings.freeTerminal(terminal);
    }
  });

  test('ESC]8;;URI ESC\\ label ESC]8;; ESC\\：label 各格读回同一 URI，其余格无链接', async () => {
    const bindings = await getGhosttyBindings();
    const terminal = bindings.createTerminal(40, 4, 100);
    const reader = new GhosttyHyperlinkReader(bindings, terminal);
    try {
      bindings.writeVt(terminal, 'ab\x1b]8;;https://example.com/a\x1b\\label\x1b]8;;\x1b\\ z');
      expect([0, 1, 7, 8].map((x) => reader.uriAt(x, 0))).toEqual([null, null, null, null]);
      for (let x = 2; x <= 6; x += 1) {
        expect(reader.uriAt(x, 0)).toBe('https://example.com/a');
      }
      expect(reader.uriAt(0, 99)).toBeNull();
    } finally {
      reader.dispose();
      bindings.freeTerminal(terminal);
    }
  });
});
