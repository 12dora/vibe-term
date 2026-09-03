import { describe, expect, test } from 'bun:test';

import { ControlModeUnescaper, unescapeControlModeData } from './unescape';

const encoder = new TextEncoder();

function bytes(...parts: Array<number | string | Uint8Array>): Uint8Array {
  const list: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') {
      list.push(part);
    } else if (typeof part === 'string') {
      list.push(...encoder.encode(part));
    } else {
      list.push(...part);
    }
  }
  return new Uint8Array(list);
}

function isViewOf(
  result: Uint8Array,
  source: Uint8Array,
  start: number,
  end = source.length
): void {
  expect(result.buffer).toBe(source.buffer);
  expect(result.byteOffset).toBe(source.byteOffset + start);
  expect(result.byteLength).toBe(end - start);
}

describe('unescapeControlModeData', () => {
  test('returns the original subarray when there is no backslash', () => {
    const line = bytes('hello world without escapes');
    const result = unescapeControlModeData(line, 0);
    expect(Array.from(result)).toEqual(Array.from(line));
    isViewOf(result, line, 0);
  });

  test('returns a view from start when the payload has no backslash', () => {
    const line = bytes('%output %0 hello');
    const result = unescapeControlModeData(line, 11);
    expect(Array.from(result)).toEqual(Array.from(bytes('hello')));
    isViewOf(result, line, 11);
  });

  test('empty payload at end of line is a zero-length view of the source', () => {
    const line = bytes('%output %0 ');
    const result = unescapeControlModeData(line, line.length);
    expect(result.length).toBe(0);
    isViewOf(result, line, line.length);
  });

  test('backslash at end of line is passed through', () => {
    const line = bytes('A\\');
    expect(Array.from(unescapeControlModeData(line, 0))).toEqual([0x41, 0x5c]);
  });

  test('backslash at end after start offset is passed through', () => {
    const line = bytes('prefix A\\');
    expect(Array.from(unescapeControlModeData(line, 7))).toEqual([0x41, 0x5c]);
  });

  test('incomplete octal at end is passed through with invalid callback', () => {
    let invalid = 0;
    const line = bytes('Z\\03');
    expect(Array.from(unescapeControlModeData(line, 0, () => invalid++))).toEqual([
      0x5a, 0x5c, 0x30, 0x33,
    ]);
    expect(invalid).toBe(1);
  });

  test('copies unescaped runs in bulk around valid octal sequences', () => {
    const line = bytes('AAAA\\011BBBB\\134CCCC');
    expect(Array.from(unescapeControlModeData(line, 0))).toEqual(
      Array.from(bytes('AAAA', 0x09, 'BBBB', 0x5c, 'CCCC'))
    );
  });

  test('reuses and grows one scratch backing buffer across escaped payloads', () => {
    const unescaper = new ControlModeUnescaper();
    const first = unescaper.unescape(bytes('A\\033B'), 0);
    const initialBuffer = first.buffer;
    expect(Array.from(first)).toEqual([0x41, 0x1b, 0x42]);

    const second = unescaper.unescape(bytes('C\\007D'), 0);
    expect(second.buffer).toBe(initialBuffer);
    expect(Array.from(second)).toEqual([0x43, 0x07, 0x44]);

    const large = unescaper.unescape(bytes(`${'x'.repeat(512)}\\033`), 0);
    expect(large.buffer).not.toBe(initialBuffer);
    expect(large.byteLength).toBe(513);
    const afterGrowth = unescaper.unescape(bytes('E\\011F'), 0);
    expect(afterGrowth.buffer).toBe(large.buffer);
    expect(Array.from(afterGrowth)).toEqual([0x45, 0x09, 0x46]);
  });
});
