// key / paste 两趟输出编码的分配记账：无论 size 阶段被拒、零长度提前返回还是写入阶段
// 抛错，requiredPtr / 输出缓冲 / writtenPtr 以及 key event、paste 输入都必须全部归还。
import { describe, expect, test } from 'bun:test';
import { GhosttyBindings } from './ghostty-wasm';

type FakeExports = ConstructorParameters<typeof GhosttyBindings>[0];
type PartialExports = Partial<FakeExports>;

type EncodeFixture = {
  output: string;
  sizeResult: number;
  writeResult: number;
  required: number | null;
  written: number | null;
  bracketed: boolean;
};

const DEFAULT_FIXTURE: EncodeFixture = {
  output: 'ok',
  sizeResult: -3,
  writeResult: 0,
  required: null,
  written: null,
  bracketed: true,
};

const KEY_EVENT_HANDLE = 909;

function createTrackedBindings(overrides: Partial<EncodeFixture> = {}) {
  const fixture: EncodeFixture = { ...DEFAULT_FIXTURE, ...overrides };
  const bytes = new TextEncoder().encode(fixture.output);
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

  const runPass = (outBufPtr: number, outBufLen: number, outWrittenPtr: number): number => {
    const view = new DataView(memory.buffer);
    if (outBufPtr === 0 && outBufLen === 0) {
      view.setUint32(outWrittenPtr, fixture.required ?? bytes.length, true);
      return fixture.sizeResult;
    }

    new Uint8Array(memory.buffer, outBufPtr, outBufLen).set(bytes.subarray(0, outBufLen));
    view.setUint32(outWrittenPtr, fixture.written ?? Math.min(bytes.length, outBufLen), true);
    return fixture.writeResult;
  };

  const exports: PartialExports = {
    memory,
    ghostty_wasm_alloc_u8_array: (len: number) => alloc('u8array', len),
    ghostty_wasm_free_u8_array: (ptr: number, len: number) => free('u8array', ptr, len),
    ghostty_wasm_alloc_u8: () => alloc('u8', 1),
    ghostty_wasm_free_u8: (ptr: number) => free('u8', ptr),
    ghostty_wasm_alloc_usize: () => alloc('usize', 4),
    ghostty_wasm_free_usize: (ptr: number) => free('usize', ptr),
    ghostty_wasm_alloc_opaque: () => alloc('opaque', 4),
    ghostty_wasm_free_opaque: (ptr: number) => free('opaque', ptr),
    ghostty_terminal_mode_get: (_terminal: number, _mode: number, outValuePtr: number) => {
      new DataView(memory.buffer).setUint8(outValuePtr, fixture.bracketed ? 1 : 0);
      return 0;
    },
    ghostty_key_event_new: (_allocatorPtr: number, outEventPtr: number) => {
      new DataView(memory.buffer).setUint32(outEventPtr, alloc('key-event', 8), true);
      return 0;
    },
    ghostty_key_event_free: (event: number) => free('key-event', event),
    ghostty_key_encoder_setopt_from_terminal: () => undefined,
    ghostty_key_event_set_action: () => undefined,
    ghostty_key_event_set_key: () => undefined,
    ghostty_key_event_set_mods: () => undefined,
    ghostty_key_event_set_consumed_mods: () => undefined,
    ghostty_key_event_set_composing: () => undefined,
    ghostty_key_event_set_utf8: () => undefined,
    ghostty_key_event_set_unshifted_codepoint: () => undefined,
    ghostty_key_encoder_encode: (
      _encoder: number,
      _event: number,
      outBufPtr: number,
      outBufLen: number,
      outWrittenPtr: number
    ) => runPass(outBufPtr, outBufLen, outWrittenPtr),
    ghostty_paste_encode: (
      _dataPtr: number,
      _dataLen: number,
      _bracketed: number,
      outBufPtr: number,
      outBufLen: number,
      outWrittenPtr: number
    ) => runPass(outBufPtr, outBufLen, outWrittenPtr),
  };

  return { bindings: new GhosttyBindings(exports as FakeExports, {}), liveAllocations: live };
}

const KEY_OPTIONS = {
  action: 'press',
  keyCode: 65,
  mods: 0,
  composing: false,
  utf8: 'a',
  unshiftedCodepoint: 97,
} as const;

describe('encodeKeyEvent 输出编码记账', () => {
  test('正常路径返回编码结果并释放全部分配', () => {
    const { bindings, liveAllocations } = createTrackedBindings({ output: 'ESC[A' });

    expect(bindings.encodeKeyEvent(KEY_EVENT_HANDLE, 1, KEY_OPTIONS)).toBe('ESC[A');
    expect(liveAllocations.size).toBe(0);
  });

  test('size 阶段返回 SUCCESS 同样被接受', () => {
    const { bindings, liveAllocations } = createTrackedBindings({ sizeResult: 0, output: 'x' });

    expect(bindings.encodeKeyEvent(KEY_EVENT_HANDLE, 1, KEY_OPTIONS)).toBe('x');
    expect(liveAllocations.size).toBe(0);
  });

  test('required 为 0 时返回 null 且释放全部分配', () => {
    const { bindings, liveAllocations } = createTrackedBindings({ required: 0 });

    expect(bindings.encodeKeyEvent(KEY_EVENT_HANDLE, 1, KEY_OPTIONS)).toBeNull();
    expect(liveAllocations.size).toBe(0);
  });

  test('written 为 0 时返回 null 且释放全部分配', () => {
    const { bindings, liveAllocations } = createTrackedBindings({ written: 0 });

    expect(bindings.encodeKeyEvent(KEY_EVENT_HANDLE, 1, KEY_OPTIONS)).toBeNull();
    expect(liveAllocations.size).toBe(0);
  });

  test('size 阶段返回非法结果时抛错且不泄漏 key event 与 utf8 输入', () => {
    const { bindings, liveAllocations } = createTrackedBindings({ sizeResult: -2 });

    expect(() => bindings.encodeKeyEvent(KEY_EVENT_HANDLE, 1, KEY_OPTIONS)).toThrow(
      'ghostty_key_encoder_encode(size) failed with result -2'
    );
    expect(liveAllocations.size).toBe(0);
  });

  test('写入阶段失败时抛错且不泄漏输出缓冲', () => {
    const { bindings, liveAllocations } = createTrackedBindings({ writeResult: -1 });

    expect(() => bindings.encodeKeyEvent(KEY_EVENT_HANDLE, 1, KEY_OPTIONS)).toThrow(
      'ghostty_key_encoder_encode failed with result -1'
    );
    expect(liveAllocations.size).toBe(0);
  });
});

describe('encodePaste 输出编码记账', () => {
  test('正常路径返回编码结果并释放输入与输出分配', () => {
    const { bindings, liveAllocations } = createTrackedBindings({ output: 'pasted' });

    expect(bindings.encodePaste(1, 'pasted')).toBe('pasted');
    expect(liveAllocations.size).toBe(0);
  });

  test('required 为 0 时返回空串而非 null', () => {
    const { bindings, liveAllocations } = createTrackedBindings({ required: 0 });

    expect(bindings.encodePaste(1, 'anything')).toBe('');
    expect(liveAllocations.size).toBe(0);
  });

  test('written 为 0 时返回空串', () => {
    const { bindings, liveAllocations } = createTrackedBindings({ written: 0 });

    expect(bindings.encodePaste(1, 'anything')).toBe('');
    expect(liveAllocations.size).toBe(0);
  });

  test('size 阶段返回非法结果时抛错且释放输入缓冲', () => {
    const { bindings, liveAllocations } = createTrackedBindings({ sizeResult: -2 });

    expect(() => bindings.encodePaste(1, 'anything')).toThrow(
      'ghostty_paste_encode(size) failed with result -2'
    );
    expect(liveAllocations.size).toBe(0);
  });

  test('写入阶段失败时抛错且释放输入与输出缓冲', () => {
    const { bindings, liveAllocations } = createTrackedBindings({ writeResult: -1 });

    expect(() => bindings.encodePaste(1, 'anything')).toThrow(
      'ghostty_paste_encode failed with result -1'
    );
    expect(liveAllocations.size).toBe(0);
  });

  test('非 bracketed 模式同样完成两趟编码', () => {
    const { bindings, liveAllocations } = createTrackedBindings({
      bracketed: false,
      output: 'raw',
    });

    expect(bindings.encodePaste(1, 'raw')).toBe('raw');
    expect(liveAllocations.size).toBe(0);
  });
});
