export const SNAPSHOT_FIELD_SEPARATOR = '|';

export const TMUX_SESSION_ID_PATTERN = /^\$\d+$/;
export const TMUX_WINDOW_ID_PATTERN = /^@\d+$/;
export const TMUX_PANE_ID_PATTERN = /^%\d+$/;

export function isTmuxSessionId(value: string | undefined): value is string {
  return typeof value === 'string' && TMUX_SESSION_ID_PATTERN.test(value);
}

export function isTmuxWindowId(value: string | undefined): value is string {
  return typeof value === 'string' && TMUX_WINDOW_ID_PATTERN.test(value);
}

export function isTmuxPaneId(value: string | undefined): value is string {
  return typeof value === 'string' && TMUX_PANE_ID_PATTERN.test(value);
}

export function parseSnapshotInteger(value: string | undefined): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }
  return Number.parseInt(value, 10);
}

export function formatSnapshotRowForLog(line: string, limit = 160): string {
  if (line.length <= limit) {
    return line;
  }
  return `${line.slice(0, Math.max(0, limit - 3))}...`;
}

// window / pane 快照行的统一格式与解析（local + ssh 共用）。
// 字段序原则：定长字段（id/数字/0-1 标志/layout）前置，自由文本（name/title/command/path）后置，
// 使含 `|` 的自由文本可以通过两端锚定安全还原。

export const WINDOW_SNAPSHOT_FORMAT = [
  '#{window_id}',
  '#{window_index}',
  '#{window_active}',
  '#{window_layout}',
  '#{window_name}',
].join(SNAPSHOT_FIELD_SEPARATOR);

export const PANE_SNAPSHOT_FORMAT = [
  '#{pane_id}',
  '#{window_id}',
  '#{pane_index}',
  '#{pane_active}',
  '#{pane_width}',
  '#{pane_height}',
  '#{pane_left}',
  '#{pane_top}',
  '#{window_active}',
  '#{pane_title}',
  '#{pane_current_command}',
  '#{pane_current_path}',
].join(SNAPSHOT_FIELD_SEPARATOR);

export interface WindowSnapshotRow {
  id: string;
  index: number;
  active: boolean;
  layout?: string;
  name: string;
}

export interface PaneSnapshotRow {
  id: string;
  windowId: string;
  index: number;
  active: boolean;
  width: number;
  height: number;
  left?: number;
  top?: number;
  windowActive: boolean;
  title?: string;
  currentCommand?: string;
  currentPath?: string;
}

function isSnapshotFlag(value: string | undefined): value is '0' | '1' {
  return value === '0' || value === '1';
}

function parseSnapshotFlag(value: string | undefined): boolean | null {
  if (!isSnapshotFlag(value)) return null;
  return value === '1';
}

function optionalSnapshotText(value: string | undefined, trimValue: boolean): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimValue ? trimmed : value;
}

const WINDOW_LAYOUT_PATTERN = /^[0-9a-fA-F]{4},[0-9x,{}[\]]+$/;

export function parseWindowSnapshotRow(line: string): WindowSnapshotRow | null {
  const parts = line.split(SNAPSHOT_FIELD_SEPARATOR);
  if (parts.length < 5) {
    return null;
  }
  const [id, indexRaw, activeRaw, layoutRaw] = parts;
  const name = parts.slice(4).join(SNAPSHOT_FIELD_SEPARATOR);
  const index = parseSnapshotInteger(indexRaw);
  if (!isTmuxWindowId(id) || index === null || !isSnapshotFlag(activeRaw)) {
    return null;
  }
  const layout =
    typeof layoutRaw === 'string' && WINDOW_LAYOUT_PATTERN.test(layoutRaw) ? layoutRaw : undefined;
  return { id, index, active: activeRaw === '1', layout, name };
}

export function parsePaneSnapshotRow(line: string): PaneSnapshotRow | null {
  const parts = splitSnapshotFields(line, 12);
  if (parts.length < 12) {
    return null;
  }
  const id = parts[0];
  const windowId = parts[1];
  const index = parseSnapshotInteger(parts[2]);
  const active = parseSnapshotFlag(parts[3]);
  const width = parseSnapshotInteger(parts[4]);
  const height = parseSnapshotInteger(parts[5]);
  const windowActive = parseSnapshotFlag(parts[8]);
  if (
    !isTmuxPaneId(id) ||
    !isTmuxWindowId(windowId) ||
    index === null ||
    active === null ||
    width === null ||
    height === null ||
    windowActive === null
  ) {
    return null;
  }
  return {
    id,
    windowId,
    index,
    active,
    width,
    height,
    left: parseSnapshotInteger(parts[6]) ?? undefined,
    top: parseSnapshotInteger(parts[7]) ?? undefined,
    windowActive,
    title: optionalSnapshotText(parts[9], false),
    currentCommand: optionalSnapshotText(parts[10], true),
    currentPath: optionalSnapshotText(parts[11], true),
  };
}

export interface SnapshotFieldLayout {
  prefixCount: number;
  suffixCount: number;
}

export const SNAPSHOT_FIELD_LAYOUTS: Readonly<Record<number, SnapshotFieldLayout>> = {
  2: { prefixCount: 1, suffixCount: 0 },
  4: { prefixCount: 2, suffixCount: 1 },
  8: { prefixCount: 3, suffixCount: 4 },
  9: { prefixCount: 3, suffixCount: 5 },
  12: { prefixCount: 9, suffixCount: 2 },
};

export function splitFlexibleSnapshotFields(
  parts: string[],
  layout: SnapshotFieldLayout
): string[] {
  const prefix = Array.from({ length: layout.prefixCount }, (_, index) => parts[index] ?? '');
  const middleEnd = layout.suffixCount === 0 ? parts.length : parts.length - layout.suffixCount;
  const middle = parts.slice(layout.prefixCount, middleEnd).join(SNAPSHOT_FIELD_SEPARATOR);
  const suffix = Array.from(
    { length: layout.suffixCount },
    (_, index) => parts.at(index - layout.suffixCount) ?? ''
  );
  return [...prefix, middle, ...suffix];
}

export function splitSnapshotFields(line: string, fieldCount: number): string[] {
  const parts = line.split(SNAPSHOT_FIELD_SEPARATOR);
  if (parts.length <= fieldCount) {
    return parts;
  }
  const layout = SNAPSHOT_FIELD_LAYOUTS[fieldCount];
  if (!layout) {
    return parts;
  }
  return splitFlexibleSnapshotFields(parts, layout);
}
