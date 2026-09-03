import { describe, expect, test } from 'bun:test';
import {
  DC_MAX_MESSAGE_BYTES,
  FRAGMENT_HEADER_SIZE,
  FRAGMENT_PAYLOAD_SIZE,
  FragmentAssembler,
  type FragmentFail,
  fragmentBytes,
} from './fragment-core';

function assembler(opts?: Partial<ConstructorParameters<typeof FragmentAssembler>[0]>) {
  return new FragmentAssembler({
    maxFrameBytes: 1024 * 1024,
    maxTotal: 32,
    refreshDeadline: false,
    ...opts,
  });
}

function fail(kind: FragmentFail, message: string): null {
  throw new Error(`${kind}: ${message}`);
}

function payload(size: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) & 0xff;
  return bytes;
}

describe('fragmentBytes wire format', () => {
  test('header is [frameId u32 LE][idx u16 LE][total u16 LE] then payload', () => {
    const parts = fragmentBytes(0x01020304, new Uint8Array([0xaa, 0xbb]), FRAGMENT_PAYLOAD_SIZE);
    expect(parts).toHaveLength(1);
    const head = parts[0] as Uint8Array;
    expect(Array.from(head.subarray(0, 8))).toEqual([0x04, 0x03, 0x02, 0x01, 0, 0, 1, 0]);
    expect(Array.from(head.subarray(8))).toEqual([0xaa, 0xbb]);
  });

  test('empty payload is one header-only fragment; oversized payload splits', () => {
    expect(fragmentBytes(7, new Uint8Array(0), FRAGMENT_PAYLOAD_SIZE)[0]?.byteLength).toBe(
      FRAGMENT_HEADER_SIZE
    );
    const over = fragmentBytes(
      2,
      new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 1).fill(2),
      FRAGMENT_PAYLOAD_SIZE
    );
    expect(over).toHaveLength(2);
    expect(over[0]?.byteLength).toBe(DC_MAX_MESSAGE_BYTES);
    expect(Array.from((over[0] as Uint8Array).subarray(4, 8))).toEqual([0, 0, 2, 0]);
    expect(Array.from((over[1] as Uint8Array).subarray(4, 8))).toEqual([1, 0, 2, 0]);
  });
});

describe('FragmentAssembler', () => {
  test('single-fragment returns a payload view of the source buffer (ws 0-copy contract)', () => {
    const core = assembler();
    const chunk = fragmentBytes(
      1,
      new Uint8Array([10, 20, 30]),
      FRAGMENT_PAYLOAD_SIZE
    )[0] as Uint8Array;
    const out = core.push(chunk, fail);
    expect(out).not.toBeNull();
    expect(out!.buffer).toBe(chunk.buffer);
    expect(out!.byteOffset).toBe(FRAGMENT_HEADER_SIZE);
    expect(Array.from(out!)).toEqual([10, 20, 30]);
    expect(core.pendingBytes).toBe(0);
    chunk[FRAGMENT_HEADER_SIZE] = 99;
    expect(out![0]).toBe(99);
  });

  test('multi-fragment reassembly is byte-exact and copies once into a new buffer', () => {
    const original = payload(FRAGMENT_PAYLOAD_SIZE + 123, 5);
    const parts = fragmentBytes(42, original, FRAGMENT_PAYLOAD_SIZE);
    expect(parts.length).toBe(2);
    const core = assembler();
    expect(core.push(parts[0] as Uint8Array, fail)).toBeNull();
    expect(core.pendingBytes).toBe(FRAGMENT_PAYLOAD_SIZE);
    const out = core.push(parts[1] as Uint8Array, fail);
    expect(out).toEqual(original);
    expect(out!.buffer).not.toBe((parts[0] as Uint8Array).buffer);
    expect(core.pendingBytes).toBe(0);
    (parts[0] as Uint8Array)[FRAGMENT_HEADER_SIZE] = 0xff;
    expect(out![0]).not.toBe(0xff);
  });

  test('out-of-order pieces still reassemble in idx order', () => {
    const original = payload(FRAGMENT_PAYLOAD_SIZE + 7, 9);
    const parts = fragmentBytes(3, original, FRAGMENT_PAYLOAD_SIZE);
    const core = assembler();
    expect(core.push(parts[1] as Uint8Array, fail)).toBeNull();
    expect(core.push(parts[0] as Uint8Array, fail)).toEqual(original);
  });

  test('expire drops an incomplete frame; a later sibling cannot complete it', () => {
    let now = 1_000;
    const core = assembler({ timeoutMs: 50, now: () => now });
    const parts = fragmentBytes(3, payload(FRAGMENT_PAYLOAD_SIZE + 1), FRAGMENT_PAYLOAD_SIZE);
    expect(core.push(parts[0] as Uint8Array, fail)).toBeNull();
    expect(core.pendingBytes).toBe(FRAGMENT_PAYLOAD_SIZE);
    now = 1_060;
    expect(core.push(parts[1] as Uint8Array, fail)).toBeNull();
    expect(core.pendingBytes).toBe((parts[1] as Uint8Array).byteLength - FRAGMENT_HEADER_SIZE);
  });

  test('expire is a no-op when nothing is pending (single-fragment leaves pending empty)', () => {
    const core = assembler();
    const chunk = fragmentBytes(
      1,
      new Uint8Array(70).fill(0x61),
      FRAGMENT_PAYLOAD_SIZE
    )[0] as Uint8Array;
    expect(core.push(chunk, fail)?.byteLength).toBe(70);
    expect(core.pendingBytes).toBe(0);
    core.sweep();
    expect(core.push(chunk, fail)?.byteLength).toBe(70);
    expect(core.pendingBytes).toBe(0);
  });
});

describe('FragmentAssembler micro-bench', () => {
  test('reports ns/op for 70 B keystroke and 32 KiB single-fragment frames', () => {
    const core = assembler();
    const keystroke = fragmentBytes(
      1,
      new Uint8Array(70).fill(0x61),
      FRAGMENT_PAYLOAD_SIZE
    )[0] as Uint8Array;
    const frame32k = fragmentBytes(
      2,
      new Uint8Array(32 * 1024).fill(0x62),
      FRAGMENT_PAYLOAD_SIZE
    )[0] as Uint8Array;
    const multi = fragmentBytes(3, payload(FRAGMENT_PAYLOAD_SIZE + 100, 3), FRAGMENT_PAYLOAD_SIZE);

    const timeNs = (iters: number, run: () => void): number => {
      for (let i = 0; i < Math.min(iters, 2000); i++) run();
      const samples: number[] = [];
      for (let round = 0; round < 9; round++) {
        const started = performance.now();
        for (let i = 0; i < iters; i++) run();
        samples.push(((performance.now() - started) * 1e6) / iters);
      }
      samples.sort((a, b) => a - b);
      return samples[Math.floor(samples.length / 2)] ?? 0;
    };

    const keystrokeNs = timeNs(80_000, () => {
      core.push(keystroke, fail);
    });
    const frame32kNs = timeNs(20_000, () => {
      core.push(frame32k, fail);
    });
    const multiNs = timeNs(8_000, () => {
      core.push(multi[0] as Uint8Array, fail);
      core.push(multi[1] as Uint8Array, fail);
    });
    console.log(
      `assemble 70B=${keystrokeNs.toFixed(1)}ns  32KiB=${frame32kNs.toFixed(1)}ns  2-piece=${multiNs.toFixed(1)}ns`
    );
    expect(keystrokeNs).toBeLessThan(5_000);
    expect(frame32kNs).toBeLessThan(20_000);
  });
});
