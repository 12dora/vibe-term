import { describe, expect, test } from 'bun:test';
import {
  applyShiftDirtyDowngrade,
  lookupShiftedPreviousRow,
  resolveShiftBaseline,
} from './render-state-shift';
import type { GhosttyRenderRow, GhosttyRenderSnapshotMeta } from './types';

function row(y: number, dirty = false): GhosttyRenderRow {
  return { y, dirty, wrap: false, wrapContinuation: false, text: '', cells: [] };
}

function meta(overrides: Partial<GhosttyRenderSnapshotMeta> = {}): GhosttyRenderSnapshotMeta {
  return {
    cols: 80,
    rows: 4,
    dirty: 'full',
    cursor: {
      style: 'block',
      visible: true,
      blinking: false,
      passwordInput: false,
      x: null,
      y: null,
      wideTail: false,
    },
    colors: {
      background: { r: 0, g: 0, b: 0 },
      foreground: { r: 255, g: 255, b: 255 },
      cursor: null,
      palette: [],
    },
    ...overrides,
  };
}

describe('render-state shift baseline', () => {
  test('几何/配色可比且位移为非零整数时才 shifted', () => {
    const settled = [row(0), row(1), row(2), row(3)];
    expect(resolveShiftBaseline(settled, meta(), 80, false, 2)).toEqual({
      comparable: true,
      shifted: 2,
    });
    expect(resolveShiftBaseline(settled, meta(), 80, false, 0).shifted).toBe(0);
    expect(resolveShiftBaseline(settled, meta(), 40, false, 2).comparable).toBe(false);
    expect(resolveShiftBaseline(null, meta(), 80, false, 2).shifted).toBe(0);
  });

  test('lookup 按 rowIndex + shifted 取上一帧行', () => {
    const settled = [row(0), row(1), row(2), row(3)];
    expect(lookupShiftedPreviousRow(true, settled, 0, 1)?.y).toBe(1);
    expect(lookupShiftedPreviousRow(true, settled, 0, -1)).toBeNull();
    expect(lookupShiftedPreviousRow(false, settled, 0, 1)).toBeNull();
  });

  test('完整可比帧把 full/shifted 降成 partial 或 clean', () => {
    const full = meta({ dirty: 'full' });
    applyShiftDirtyDowngrade(full, true, 0, [row(0), row(1)]);
    expect(full.dirty).toBe('clean');

    const shifted = meta({ dirty: 'full' });
    applyShiftDirtyDowngrade(shifted, true, 2, [row(0), row(1)]);
    expect(shifted.dirty).toBe('partial');

    const mixed = meta({ dirty: 'full' });
    applyShiftDirtyDowngrade(mixed, true, 0, [row(0, true), row(1)]);
    expect(mixed.dirty).toBe('partial');
  });
});
