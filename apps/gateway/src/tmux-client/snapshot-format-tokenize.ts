export const SNAPSHOT_ESCAPE = '\\';

export interface FlexibleFieldLayout {
  prefix: number;
  suffix: number;
}

export const FLEXIBLE_FIELD_LAYOUTS: Record<number, FlexibleFieldLayout> = {
  2: { prefix: 1, suffix: 0 },
  4: { prefix: 2, suffix: 1 },
  8: { prefix: 3, suffix: 4 },
  9: { prefix: 3, suffix: 5 },
};

export type SnapshotColumn<T extends object> = {
  [K in keyof T]-?: {
    name: K;
    required: boolean;
    parse: (raw: string) => T[K] | null | undefined;
  };
}[keyof T];

export function tokenizeSnapshotFields(line: string, separator: string): string[] {
  const fields: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === SNAPSHOT_ESCAPE && line[i + 1] === separator) {
      current += SNAPSHOT_ESCAPE;
      continue;
    }
    if (ch === separator) {
      fields.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

export function foldFlexibleFields(
  tokens: readonly string[],
  layout: FlexibleFieldLayout,
  separator: string
): string[] {
  const expected = layout.prefix + layout.suffix + 1;
  if (tokens.length <= expected) {
    return tokens.slice();
  }
  const tailStart = tokens.length - layout.suffix;
  const middle = tokens.slice(layout.prefix, tailStart).join(separator);
  return [...tokens.slice(0, layout.prefix), middle, ...tokens.slice(tailStart)];
}

export function parseSnapshotColumns<T extends object>(
  fields: readonly string[],
  columns: readonly SnapshotColumn<T>[]
): T | null {
  if (fields.length < columns.length) {
    return null;
  }
  const row = {} as T;
  for (let i = 0; i < columns.length; i += 1) {
    const column = columns[i];
    if (!assignSnapshotColumn(row, column, fields[i] ?? '')) {
      return null;
    }
  }
  return row;
}

function assignSnapshotColumn<T extends object>(
  row: T,
  column: SnapshotColumn<T>,
  raw: string
): boolean {
  const parsed = column.parse(raw);
  if (parsed === null) {
    if (column.required) {
      return false;
    }
    Object.assign(row, { [column.name]: undefined });
    return true;
  }
  Object.assign(row, { [column.name]: parsed });
  return true;
}
