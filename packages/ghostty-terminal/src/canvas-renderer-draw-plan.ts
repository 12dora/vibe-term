import type { GhosttyRenderDirtyState, GhosttyRenderRow } from './types';

export function resolveEffectiveDirty(
  wiped: boolean,
  forceFull: boolean | undefined,
  dirty: GhosttyRenderDirtyState
): GhosttyRenderDirtyState {
  return wiped || forceFull === true ? 'full' : dirty;
}

export function wantsScrollBlit(
  effectiveDirty: GhosttyRenderDirtyState,
  scrollDelta: number,
  rows: number
): boolean {
  return (
    effectiveDirty === 'partial' &&
    Number.isInteger(scrollDelta) &&
    scrollDelta !== 0 &&
    Math.abs(scrollDelta) < rows
  );
}

export function shouldDrawAllRows(
  effectiveDirty: GhosttyRenderDirtyState,
  wantsBlit: boolean,
  scrollBlitted: boolean
): boolean {
  return effectiveDirty === 'full' || (wantsBlit && !scrollBlitted);
}

export function expandNeighborRows(
  allRows: GhosttyRenderRow[],
  dirtyRows: GhosttyRenderRow[],
  drawAllRows: boolean
): GhosttyRenderRow[] {
  if (drawAllRows) return allRows;
  const ys = new Set<number>();
  for (const row of dirtyRows) {
    ys.add(row.y - 1);
    ys.add(row.y);
    ys.add(row.y + 1);
  }
  return allRows.filter((row) => ys.has(row.y));
}
