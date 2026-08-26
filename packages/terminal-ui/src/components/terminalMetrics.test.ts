import { describe, expect, test } from 'bun:test';
import { computeContainerSize } from './terminalMetrics';

const rect = { width: 800, height: 600 };
const cell = { width: 10, height: 20 };

describe('computeContainerSize', () => {
  test('returns null for a collapsed container', () => {
    expect(computeContainerSize({ rect: { width: 0, height: 600 }, cell })).toBeNull();
    expect(computeContainerSize({ rect: { width: 800, height: 0 }, cell })).toBeNull();
  });

  test('prefers the proposed column count', () => {
    expect(computeContainerSize({ rect, cell, proposeDimensions: () => ({ cols: 111 }) })).toEqual({
      cols: 111,
      rows: 30,
    });
  });

  test('falls back to cell width when proposeDimensions returns nothing or throws', () => {
    expect(computeContainerSize({ rect, cell, proposeDimensions: () => null })).toEqual({
      cols: 80,
      rows: 30,
    });
    expect(
      computeContainerSize({
        rect,
        cell,
        proposeDimensions: () => {
          throw new Error('renderer not ready');
        },
      })
    ).toEqual({ cols: 80, rows: 30 });
  });

  test('falls back to default cell metrics when the render service is unavailable', () => {
    expect(computeContainerSize({ rect, cell: null })).toEqual({
      cols: Math.floor(800 / 9),
      rows: Math.floor(600 / 17),
    });
  });

  test('clamps to the two-cell minimum', () => {
    expect(
      computeContainerSize({
        rect: { width: 4, height: 4 },
        cell,
        proposeDimensions: () => ({ cols: 1 }),
      })
    ).toEqual({ cols: 2, rows: 2 });
  });
});
