import { describe, expect, test } from 'bun:test';
import { parseRangeHeader } from './file-http';

describe('parseRangeHeader', () => {
  test('无 Range 表示整文件', () => {
    expect(parseRangeHeader(null, 10)).toBeNull();
  });

  test('闭区间 bytes=a-b 是半开 [start, end)', () => {
    expect(parseRangeHeader('bytes=0-2', 10)).toEqual({ start: 0, end: 3 });
    expect(parseRangeHeader('bytes=2-4', 5)).toEqual({ start: 2, end: 5 });
    expect(parseRangeHeader('bytes=0-0', 5)).toEqual({ start: 0, end: 1 });
  });

  test('开尾 bytes=a- 与后缀 bytes=-n', () => {
    expect(parseRangeHeader('bytes=2-', 5)).toEqual({ start: 2, end: 5 });
    expect(parseRangeHeader('bytes=-2', 5)).toEqual({ start: 3, end: 5 });
  });

  test('越界或畸形为 unsatisfiable', () => {
    expect(parseRangeHeader('bytes=5-6', 5)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=4-1', 5)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=', 5)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=0-1,2-3', 5)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=0-2', 0)).toBe('unsatisfiable');
  });

  test('end 超出文件尾时截到 size', () => {
    expect(parseRangeHeader('bytes=0-999', 5)).toEqual({ start: 0, end: 5 });
  });
});
