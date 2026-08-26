export function aggregateByParent<TRow, TAcc>(
  rows: readonly TRow[],
  getParentId: (row: TRow) => string,
  createAcc: () => TAcc,
  fold: (acc: TAcc, row: TRow) => void
): Map<string, TAcc> {
  const counters = new Map<string, TAcc>();
  for (const row of rows) {
    const id = getParentId(row);
    let current = counters.get(id);
    if (!current) {
      current = createAcc();
      counters.set(id, current);
    }
    fold(current, row);
  }
  return counters;
}
