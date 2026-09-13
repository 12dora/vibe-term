import { describe, expect, test } from 'bun:test';
import { emptyStreamCap, takeStreamBytes } from './stream-cap';

describe('takeStreamBytes', () => {
  test('splits into <= chunk bytes and does not truncate an exact fill', () => {
    const cap = emptyStreamCap();
    const parts = takeStreamBytes(cap, new Uint8Array(10), 4, 10);
    expect(parts.map((p) => p.byteLength)).toEqual([4, 4, 2]);
    expect(cap.sent).toBe(10);
    expect(cap.truncated).toBe(false);
  });

  test('drops bytes past the cap and sets truncated', () => {
    const cap = emptyStreamCap();
    const first = takeStreamBytes(cap, new Uint8Array(8), 8, 8);
    expect(first).toHaveLength(1);
    expect(cap.truncated).toBe(false);
    const extra = takeStreamBytes(cap, new Uint8Array(3), 8, 8);
    expect(extra).toEqual([]);
    expect(cap.truncated).toBe(true);
  });

  test('truncates within a single oversized chunk', () => {
    const cap = emptyStreamCap();
    const parts = takeStreamBytes(cap, new Uint8Array(20), 8, 10);
    expect(parts.map((p) => p.byteLength)).toEqual([8, 2]);
    expect(cap.truncated).toBe(true);
    expect(cap.sent).toBe(10);
  });
});
