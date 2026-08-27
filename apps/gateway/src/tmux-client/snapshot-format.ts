import {
  FLEXIBLE_FIELD_LAYOUTS,
  type SnapshotColumn,
  foldFlexibleFields,
  parseSnapshotColumns,
  tokenizeSnapshotFields,
} from './snapshot-format-tokenize';

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

function parseRequiredPaneId(raw: string): string | null {
  return isTmuxPaneId(raw) ? raw : null;
}

function parseRequiredWindowId(raw: string): string | null {
  return isTmuxWindowId(raw) ? raw : null;
}

function parseSnapshotFlag(raw: string): boolean | null {
  if (!isSnapshotFlag(raw)) {
    return null;
  }
  return raw === '1';
}

function parseOptionalInteger(raw: string): number | undefined {
  return parseSnapshotInteger(raw) ?? undefined;
}

function parseOptionalTitle(raw: string): string | undefined {
  return raw.trim() ? raw : undefined;
}

function parseOptionalTrimmed(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

const PANE_FLEXIBLE_LAYOUT = { prefix: 9, suffix: 2 };

const PANE_COLUMNS: readonly SnapshotColumn<PaneSnapshotRow>[] = [
  { name: 'id', required: true, parse: parseRequiredPaneId },
  { name: 'windowId', required: true, parse: parseRequiredWindowId },
  { name: 'index', required: true, parse: parseSnapshotInteger },
  { name: 'active', required: true, parse: parseSnapshotFlag },
  { name: 'width', required: true, parse: parseSnapshotInteger },
  { name: 'height', required: true, parse: parseSnapshotInteger },
  { name: 'left', required: false, parse: parseOptionalInteger },
  { name: 'top', required: false, parse: parseOptionalInteger },
  { name: 'windowActive', required: true, parse: parseSnapshotFlag },
  { name: 'title', required: false, parse: parseOptionalTitle },
  { name: 'currentCommand', required: false, parse: parseOptionalTrimmed },
  { name: 'currentPath', required: false, parse: parseOptionalTrimmed },
];

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
  const tokens = tokenizeSnapshotFields(line, SNAPSHOT_FIELD_SEPARATOR);
  const fields = foldFlexibleFields(tokens, PANE_FLEXIBLE_LAYOUT, SNAPSHOT_FIELD_SEPARATOR);
  return parseSnapshotColumns(fields, PANE_COLUMNS);
}

export function splitSnapshotFields(line: string, fieldCount: number): string[] {
  const tokens = tokenizeSnapshotFields(line, SNAPSHOT_FIELD_SEPARATOR);
  const layout = FLEXIBLE_FIELD_LAYOUTS[fieldCount];
  if (!layout) {
    return tokens;
  }
  return foldFlexibleFields(tokens, layout, SNAPSHOT_FIELD_SEPARATOR);
}
