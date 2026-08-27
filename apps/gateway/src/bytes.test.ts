import { describe, expect, test } from 'bun:test';
import { bytesEqual, bytesHex, concatBytes, copyBytes, truncateUtf8Tail } from './bytes';

describe('bytes helpers', () => {
  test('copyBytes returns a distinct buffer with the same contents', () => {
    const source = new Uint8Array([1, 2, 3]);
    const copied = copyBytes(source);
    expect(copied).not.toBe(source);
    expect([...copied]).toEqual([1, 2, 3]);
    source[0] = 9;
    expect(copied[0]).toBe(1);
  });

  test('bytesEqual compares length and contents', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  test('bytesHex encodes each byte as two lowercase hex digits', () => {
    expect(bytesHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });

  test('truncateUtf8Tail does not split a multi-byte codepoint', () => {
    const encoded = new TextEncoder().encode('éx');
    const truncated = truncateUtf8Tail(encoded, 2);
    expect(new TextDecoder().decode(truncated)).toBe('x');
  });

  test('concatBytes joins chunks in order', () => {
    const joined = concatBytes(new Uint8Array([1]), new Uint8Array([2, 3]));
    expect([...joined]).toEqual([1, 2, 3]);
  });
});
