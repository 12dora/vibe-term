import { describe, expect, test } from 'bun:test';
import {
  complementRanges,
  coveredBytes,
  normalizeRanges,
  rangesCover,
  splitRanges,
} from './ranges';

describe('ranges', () => {
  test('normalize merges overlapping and adjacent ranges', () => {
    expect(
      normalizeRanges([
        { offset: 10, length: 5 },
        { offset: 0, length: 4 },
        { offset: 4, length: 2 },
        { offset: 12, length: 10 },
      ])
    ).toEqual([
      { offset: 0, length: 6 },
      { offset: 10, length: 12 },
    ]);
  });

  test('normalize drops empty and negative ranges', () => {
    expect(
      normalizeRanges([
        { offset: 0, length: 0 },
        { offset: 5, length: -1 },
      ])
    ).toEqual([]);
  });

  test('complement returns the gaps', () => {
    expect(complementRanges(100, [{ offset: 10, length: 20 }])).toEqual([
      { offset: 0, length: 10 },
      { offset: 30, length: 70 },
    ]);
    expect(complementRanges(100, [{ offset: 0, length: 100 }])).toEqual([]);
    expect(complementRanges(0, [])).toEqual([]);
  });

  test('coveredBytes and rangesCover', () => {
    expect(
      coveredBytes([
        { offset: 0, length: 5 },
        { offset: 3, length: 5 },
      ])
    ).toBe(8);
    expect(rangesCover(8, [{ offset: 0, length: 8 }])).toBe(true);
    expect(rangesCover(9, [{ offset: 0, length: 8 }])).toBe(false);
  });

  test('split cuts a contiguous gap into N equal disjoint pieces', () => {
    const parts = splitRanges([{ offset: 0, length: 100 }], 4);
    expect(parts).toHaveLength(4);
    expect(parts).toEqual([
      { offset: 0, length: 25 },
      { offset: 25, length: 25 },
      { offset: 50, length: 25 },
      { offset: 75, length: 25 },
    ]);
    expect(coveredBytes(parts)).toBe(100);
  });

  test('split keeps an already fragmented gap as is', () => {
    const missing = [
      { offset: 0, length: 10 },
      { offset: 50, length: 10 },
      { offset: 90, length: 10 },
    ];
    expect(splitRanges(missing, 2)).toEqual(missing);
  });

  test('split with one stream is a no-op', () => {
    expect(splitRanges([{ offset: 7, length: 30 }], 1)).toEqual([{ offset: 7, length: 30 }]);
  });
});
