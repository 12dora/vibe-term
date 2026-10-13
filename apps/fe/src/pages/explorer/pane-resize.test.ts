import { describe, expect, test } from 'bun:test';
import { effectivePaneSizes, equalPaneSizes, resizePanes } from './pane-resize';

const MIN = 0.15;

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe('resizePanes', () => {
  test('moves space between the two neighbours only', () => {
    const next = resizePanes([0.5, 0.5], 0, 0.1, MIN);
    expect(next[0]).toBeCloseTo(0.6);
    expect(next[1]).toBeCloseTo(0.4);
  });

  test('negative delta shrinks the left pane', () => {
    const next = resizePanes([0.5, 0.5], 0, -0.2, MIN);
    expect(next[0]).toBeCloseTo(0.3);
    expect(next[1]).toBeCloseTo(0.7);
  });

  test('clamps both sides to the minimum fraction', () => {
    const grown = resizePanes([0.5, 0.5], 0, 0.9, MIN);
    expect(grown[0]).toBeCloseTo(0.85);
    expect(grown[1]).toBeCloseTo(MIN);
    const shrunk = resizePanes([0.5, 0.5], 0, -0.9, MIN);
    expect(shrunk[0]).toBeCloseTo(MIN);
    expect(shrunk[1]).toBeCloseTo(0.85);
  });

  test('leaves the other panes untouched and keeps the sum', () => {
    const sizes = [0.3, 0.3, 0.4];
    const next = resizePanes(sizes, 1, 0.1, MIN);
    expect(next[0]).toBe(0.3);
    expect(next[1]).toBeCloseTo(0.4);
    expect(next[2]).toBeCloseTo(0.3);
    expect(sum(next)).toBeCloseTo(1);
  });

  test('does not mutate the input', () => {
    const sizes = [0.5, 0.5];
    resizePanes(sizes, 0, 0.1, MIN);
    expect(sizes).toEqual([0.5, 0.5]);
  });

  test('out-of-range index and non-finite delta return a copy', () => {
    const sizes = [0.5, 0.5];
    expect(resizePanes(sizes, 1, 0.1, MIN)).toEqual(sizes);
    expect(resizePanes(sizes, -1, 0.1, MIN)).toEqual(sizes);
    expect(resizePanes(sizes, 0, Number.NaN, MIN)).toEqual(sizes);
    expect(resizePanes(sizes, 0, 0.1, MIN)).not.toBe(sizes);
  });

  test('returns the sizes unchanged when the pair cannot hold two minimums', () => {
    expect(resizePanes([0.1, 0.1, 0.8], 0, 0.05, MIN)).toEqual([0.1, 0.1, 0.8]);
  });
});

describe('equalPaneSizes', () => {
  test('splits evenly', () => {
    expect(equalPaneSizes(1)).toEqual([1]);
    expect(equalPaneSizes(2)).toEqual([0.5, 0.5]);
    expect(sum(equalPaneSizes(3))).toBeCloseTo(1);
    expect(equalPaneSizes(0)).toEqual([]);
  });
});

describe('effectivePaneSizes', () => {
  test('prefers a preview of matching length', () => {
    expect(effectivePaneSizes([0.7, 0.3], [0.5, 0.5], 2)).toEqual([0.7, 0.3]);
  });

  test('ignores a stale preview', () => {
    expect(effectivePaneSizes([0.4, 0.3, 0.3], [0.5, 0.5], 2)).toEqual([0.5, 0.5]);
  });

  test('falls back to equal sizes when nothing matches', () => {
    expect(effectivePaneSizes(null, [1], 2)).toEqual([0.5, 0.5]);
  });
});
