import { describe, expect, test } from 'bun:test';
import {
  DC_MAX_MESSAGE_BYTES,
  FRAGMENT_HEADER_SIZE,
  FRAGMENT_PAYLOAD_SIZE,
  fragmentBytes,
} from './fragment-core';

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
