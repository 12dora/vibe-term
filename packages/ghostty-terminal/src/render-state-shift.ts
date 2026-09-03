import type { GhosttyRenderRow, GhosttyRenderSnapshotMeta } from './types';

export function resolveShiftBaseline(
  settled: GhosttyRenderRow[] | null,
  meta: Pick<GhosttyRenderSnapshotMeta, 'rows' | 'cols'>,
  previousCols: number,
  colorsChanged: boolean,
  scrollDelta: number
): { comparable: boolean; shifted: number } {
  const comparable =
    settled !== null &&
    settled.length === meta.rows &&
    previousCols === meta.cols &&
    !colorsChanged;
  const shifted =
    comparable &&
    Number.isInteger(scrollDelta) &&
    scrollDelta !== 0 &&
    Math.abs(scrollDelta) < meta.rows
      ? scrollDelta
      : 0;
  return { comparable, shifted };
}

export function lookupShiftedPreviousRow(
  comparable: boolean,
  settled: GhosttyRenderRow[] | null,
  rowIndex: number,
  shifted: number
): GhosttyRenderRow | null {
  if (!comparable || !settled) return null;
  const previousIndex = rowIndex + shifted;
  if (previousIndex < 0 || previousIndex >= settled.length) return null;
  return settled[previousIndex] ?? null;
}

export function applyShiftDirtyDowngrade(
  meta: GhosttyRenderSnapshotMeta,
  comparable: boolean,
  shifted: number,
  rows: readonly GhosttyRenderRow[]
): void {
  if (!(comparable && (meta.dirty === 'full' || shifted !== 0))) {
    return;
  }
  const changedRows = rows.reduce((count, row) => count + (row.dirty ? 1 : 0), 0);
  if (changedRows === 0) {
    meta.dirty = shifted === 0 ? 'clean' : 'partial';
    return;
  }
  if (changedRows < rows.length) {
    meta.dirty = 'partial';
  }
}
