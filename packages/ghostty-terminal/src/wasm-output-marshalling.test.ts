// 两趟输出 ABI 的协议契约：接受的 size 结果、零长度返回、错误标签与释放顺序。
// 用纯记账版 memory 驱动，任何提前返回或抛错都必须把三块临时分配还回去。
import { describe, expect, test } from 'bun:test';
import { type WasmOutputMemory, encodeOwnedUtf8Output } from './wasm-output-marshalling';

type EncodePass = { outPtr: number; capacity: number; writtenPtr: number };

type EncodeFixture = {
  output: string;
  sizeResult: number;
  writeResult: number;
  required: number | null;
  written: number | null;
};

const DEFAULT_FIXTURE: EncodeFixture = {
  output: 'ok',
  sizeResult: -3,
  writeResult: 0,
  required: null,
  written: null,
};

function assertResult(result: number, action: string): void {
  if (result === 0) {
    return;
  }

  throw new Error(`${action} failed with result ${result}`);
}

function createHarness(overrides: Partial<EncodeFixture> = {}) {
  const fixture: EncodeFixture = { ...DEFAULT_FIXTURE, ...overrides };
  const bytes = new TextEncoder().encode(fixture.output);
  const live = new Map<number, { kind: string; len: number }>();
  const freeOrder: string[] = [];
  const passes: EncodePass[] = [];
  const words = new Map<number, number>();
  const buffers = new Map<number, Uint8Array>();
  let next = 8;

  const alloc = (kind: string, len: number): number => {
    const ptr = next;
    next += Math.max(8, len);
    live.set(ptr, { kind, len });
    return ptr;
  };
  const free = (kind: string, ptr: number, len: number): void => {
    const entry = live.get(ptr);
    if (!entry || entry.kind !== kind || entry.len !== len) {
      throw new Error(`unexpected free ${kind}/${len} at ${ptr}`);
    }
    live.delete(ptr);
    freeOrder.push(`${kind}:${len}`);
  };

  const memory: WasmOutputMemory = {
    allocUsize: () => alloc('usize', 4),
    freeUsize: (ptr) => free('usize', ptr, 4),
    allocBytes: (len) => {
      const ptr = alloc('bytes', len);
      buffers.set(ptr, new Uint8Array(len));
      return ptr;
    },
    freeBytes: (ptr, len) => free('bytes', ptr, len),
    readUsize: (ptr) => words.get(ptr) ?? 0,
    readOwnedUtf8: (ptr, len) => {
      const buffer = buffers.get(ptr);
      if (!buffer) {
        throw new Error(`readOwnedUtf8 on unknown buffer ${ptr}`);
      }
      return new TextDecoder().decode(buffer.subarray(0, len));
    },
  };

  const encoding = {
    label: 'fake_encode',
    assertResult,
    encode: (outPtr: number, capacity: number, writtenPtr: number): number => {
      passes.push({ outPtr, capacity, writtenPtr });
      if (outPtr === 0 && capacity === 0) {
        words.set(writtenPtr, fixture.required ?? bytes.length);
        return fixture.sizeResult;
      }

      buffers.get(outPtr)?.set(bytes.subarray(0, capacity));
      words.set(writtenPtr, fixture.written ?? Math.min(bytes.length, capacity));
      return fixture.writeResult;
    },
  };

  return { memory, encoding, live, freeOrder, passes };
}

describe('encodeOwnedUtf8Output', () => {
  test('两趟编码后按写入长度解码，并按 buffer→written→required 顺序释放', () => {
    const { memory, encoding, live, freeOrder, passes } = createHarness({ output: 'hello' });

    expect(encodeOwnedUtf8Output(memory, encoding)).toBe('hello');
    expect(passes[0]).toMatchObject({ outPtr: 0, capacity: 0 });
    expect(passes[1]?.capacity).toBe(5);
    expect(freeOrder).toEqual(['bytes:5', 'usize:4', 'usize:4']);
    expect(live.size).toBe(0);
  });

  test('size 阶段返回 SUCCESS 同样被接受', () => {
    const { memory, encoding, live } = createHarness({ sizeResult: 0, output: 'hi' });

    expect(encodeOwnedUtf8Output(memory, encoding)).toBe('hi');
    expect(live.size).toBe(0);
  });

  test('required 为 0 时直接返回 null 且不分配输出缓冲', () => {
    const { memory, encoding, live, freeOrder, passes } = createHarness({ required: 0 });

    expect(encodeOwnedUtf8Output(memory, encoding)).toBeNull();
    expect(passes).toHaveLength(1);
    expect(freeOrder).toEqual(['usize:4']);
    expect(live.size).toBe(0);
  });

  test('written 为 0 时返回 null 且释放全部分配', () => {
    const { memory, encoding, live, freeOrder } = createHarness({ written: 0 });

    expect(encodeOwnedUtf8Output(memory, encoding)).toBeNull();
    expect(freeOrder).toEqual(['bytes:2', 'usize:4', 'usize:4']);
    expect(live.size).toBe(0);
  });

  test('size 阶段返回其他错误码时带 (size) 标签抛错且不泄漏', () => {
    const { memory, encoding, live, freeOrder } = createHarness({ sizeResult: -2 });

    expect(() => encodeOwnedUtf8Output(memory, encoding)).toThrow(
      'fake_encode(size) failed with result -2'
    );
    expect(freeOrder).toEqual(['usize:4']);
    expect(live.size).toBe(0);
  });

  test('写入阶段失败时带原始标签抛错且不泄漏', () => {
    const { memory, encoding, live, freeOrder } = createHarness({ writeResult: -1 });

    expect(() => encodeOwnedUtf8Output(memory, encoding)).toThrow(
      'fake_encode failed with result -1'
    );
    expect(freeOrder).toEqual(['bytes:2', 'usize:4', 'usize:4']);
    expect(live.size).toBe(0);
  });

  test('required 为负数时归零并返回 null', () => {
    const { memory, encoding, live, passes } = createHarness({ required: -4 });

    expect(encodeOwnedUtf8Output(memory, encoding)).toBeNull();
    expect(passes).toHaveLength(1);
    expect(live.size).toBe(0);
  });
});
