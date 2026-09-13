import { describe, expect, test } from 'bun:test';
import {
  expandNeighborRows,
  resolveEffectiveDirty,
  shouldDrawAllRows,
  wantsScrollBlit,
} from './canvas-renderer-draw-plan';
import {
  applyCanvasCssPixelSize,
  canvasSurfaceUnchanged,
  copyCanvasCssBox,
  measureMaxTextRun,
} from './canvas-renderer-metrics';
import type { GhosttyRenderRow } from './types';

function row(y: number, dirty = false): GhosttyRenderRow {
  return { y, dirty, wrap: false, wrapContinuation: false, text: '', cells: [] };
}

describe('canvas-renderer draw plan', () => {
  test('wiped or forceFull 覆盖 dirty，否则沿用 meta', () => {
    expect(resolveEffectiveDirty(true, false, 'clean')).toBe('full');
    expect(resolveEffectiveDirty(false, true, 'partial')).toBe('full');
    expect(resolveEffectiveDirty(false, undefined, 'partial')).toBe('partial');
  });

  test('scroll blit 只在 partial 且位移为非零整数、小于行数时成立', () => {
    expect(wantsScrollBlit('partial', 2, 10)).toBe(true);
    expect(wantsScrollBlit('full', 2, 10)).toBe(false);
    expect(wantsScrollBlit('partial', 0, 10)).toBe(false);
    expect(wantsScrollBlit('partial', 10, 10)).toBe(false);
    expect(wantsScrollBlit('partial', 1.5, 10)).toBe(false);
  });

  test('full dirty 或 blit 失败时整屏重画', () => {
    expect(shouldDrawAllRows('full', false, false)).toBe(true);
    expect(shouldDrawAllRows('partial', true, false)).toBe(true);
    expect(shouldDrawAllRows('partial', true, true)).toBe(false);
  });

  test('邻行扩展包含脏行上下一行', () => {
    const rows = [row(0), row(1, true), row(2), row(3)];
    expect(expandNeighborRows(rows, [rows[1]!], false).map((entry) => entry.y)).toEqual([0, 1, 2]);
    expect(expandNeighborRows(rows, [rows[1]!], true)).toBe(rows);
  });
});

describe('canvas-renderer metrics', () => {
  test('几何未变且位图尺寸匹配才视为 unchanged', () => {
    const current = {
      cols: 80,
      rows: 24,
      dpr: 2,
      deviceCellWidth: 16,
      deviceCellHeight: 32,
      canvasWidth: 80 * 16,
      canvasHeight: 24 * 32,
    };
    expect(
      canvasSurfaceUnchanged(current, {
        cols: 80,
        rows: 24,
        dpr: 2,
        deviceCellWidth: 16,
        deviceCellHeight: 32,
      })
    ).toBe(true);
    expect(
      canvasSurfaceUnchanged(
        { ...current, canvasWidth: 1 },
        {
          cols: 80,
          rows: 24,
          dpr: 2,
          deviceCellWidth: 16,
          deviceCellHeight: 32,
        }
      )
    ).toBe(false);
  });

  test('advance residual 决定 maxTextRun，完美对齐则用满列数', () => {
    expect(measureMaxTextRun((text) => text.length * 10, 80, 10)).toBe(80);
    expect(measureMaxTextRun((text) => text.length * 10.02, 80, 10)).toBe(20);
  });

  test('显式像素尺寸清掉 inset/right/bottom，保留 left/top=0', () => {
    const style = {
      inset: '0',
      right: '0',
      bottom: '0',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
    };
    applyCanvasCssPixelSize(style, 1080, 640);
    expect(style.inset).toBe('');
    expect(style.right).toBe('');
    expect(style.bottom).toBe('');
    expect(style.left).toBe('0');
    expect(style.top).toBe('0');
    expect(style.width).toBe('1080px');
    expect(style.height).toBe('640px');
  });

  test('copyCanvasCssBox 同步定位与尺寸，避免 scratch 升主画布时带回 inset:0', () => {
    const from = {
      inset: '',
      right: '',
      bottom: '',
      left: '0',
      top: '0',
      width: '720px',
      height: '384px',
    };
    const to = {
      inset: '0',
      right: '0',
      bottom: '0',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
    };
    copyCanvasCssBox(from, to);
    expect(to).toEqual(from);
  });
});
