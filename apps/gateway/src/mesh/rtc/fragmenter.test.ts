import { describe, expect, test } from 'bun:test';
import {
  FRAGMENT_HEADER_SIZE,
  FRAGMENT_PAYLOAD_SIZE,
  FrameReassembler,
  fragmentFrame,
} from './fragmenter';

describe('fragmentFrame', () => {
  test('empty payload is a single header-only fragment', () => {
    const parts = fragmentFrame(7, new Uint8Array(0));
    expect(parts).toHaveLength(1);
    expect(parts[0]?.byteLength).toBe(FRAGMENT_HEADER_SIZE);
    const assembled = new FrameReassembler();
    expect(assembled.push(parts[0] as Uint8Array)).toEqual(new Uint8Array(0));
  });

  test('payload under 64 KiB is a single fragment', () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const parts = fragmentFrame(1, payload);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.byteLength).toBe(FRAGMENT_HEADER_SIZE + 4);
    const assembled = new FrameReassembler();
    expect(assembled.push(parts[0] as Uint8Array)).toEqual(payload);
  });

  test('payload larger than 64 KiB is split with idx/total', () => {
    const payload = new Uint8Array(FRAGMENT_PAYLOAD_SIZE * 2 + 10);
    payload[0] = 9;
    payload[FRAGMENT_PAYLOAD_SIZE] = 8;
    payload[payload.byteLength - 1] = 7;
    const parts = fragmentFrame(42, payload);
    expect(parts).toHaveLength(3);
    expect(parts[0]?.byteLength).toBe(FRAGMENT_HEADER_SIZE + FRAGMENT_PAYLOAD_SIZE);
    expect(parts[2]?.byteLength).toBe(FRAGMENT_HEADER_SIZE + 10);

    const assembled = new FrameReassembler();
    expect(assembled.push(parts[0] as Uint8Array)).toBeNull();
    expect(assembled.push(parts[2] as Uint8Array)).toBeNull();
    expect(assembled.push(parts[1] as Uint8Array)).toEqual(payload);
  });
});

describe('FrameReassembler', () => {
  test('reassembles out-of-order fragments of concurrent frames', () => {
    const a = fragmentFrame(1, new Uint8Array([1, 1, 1]));
    const bPayload = new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 1).fill(2);
    const b = fragmentFrame(2, bPayload);
    const reassembler = new FrameReassembler();
    expect(reassembler.push(b[1] as Uint8Array)).toBeNull();
    expect(reassembler.push(a[0] as Uint8Array)).toEqual(new Uint8Array([1, 1, 1]));
    expect(reassembler.push(b[0] as Uint8Array)).toEqual(bPayload);
  });

  test('drops a frame that exceeds the per-frame timeout', () => {
    let now = 1_000;
    const reassembler = new FrameReassembler({ now: () => now, timeoutMs: 50, maxInFlight: 8 });
    const parts = fragmentFrame(3, new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 1));
    expect(reassembler.push(parts[0] as Uint8Array)).toBeNull();
    now = 1_060;
    expect(reassembler.push(parts[1] as Uint8Array)).toBeNull();
  });

  test('evicts the oldest in-flight frame when the cap is hit', () => {
    const reassembler = new FrameReassembler({ maxInFlight: 2, timeoutMs: 60_000 });
    const a = fragmentFrame(1, new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 1).fill(1));
    const b = fragmentFrame(2, new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 1).fill(2));
    const c = fragmentFrame(3, new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 1).fill(3));
    expect(reassembler.push(a[0] as Uint8Array)).toBeNull();
    expect(reassembler.push(b[0] as Uint8Array)).toBeNull();
    expect(reassembler.push(c[0] as Uint8Array)).toBeNull();
    expect(reassembler.push(a[1] as Uint8Array)).toBeNull();
    expect(reassembler.push(c[1] as Uint8Array)).toEqual(
      new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 1).fill(3)
    );
  });

  test('ignores truncated headers and inconsistent totals', () => {
    const reassembler = new FrameReassembler();
    expect(reassembler.push(new Uint8Array([1, 2, 3]))).toBeNull();
    const parts = fragmentFrame(9, new Uint8Array([4, 5]));
    const bad = (parts[0] as Uint8Array).slice();
    bad[6] = 9;
    bad[7] = 0;
    expect(reassembler.push(bad)).toBeNull();
    expect(reassembler.push(parts[0] as Uint8Array)).toEqual(new Uint8Array([4, 5]));
  });
});
