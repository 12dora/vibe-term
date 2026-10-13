// 文件管理器条目的纯逻辑：隐藏判定、排序、筛选、按名称定位。

import type { FileEntryDto } from '@vibeterm/shared';
import type { ExplorerSort, ExplorerSortKey } from '@vibeterm/stores';

export interface ExplorerEntryView {
  entry: FileEntryDto;
  hidden: boolean;
  /** i18n key：explorer.kind.<category|symlink> */
  kindKey: string;
}

export function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}

/** 目录或指向目录的符号链接：排序时置顶、打开时进入。 */
export function isDirectoryEntry(entry: FileEntryDto): boolean {
  return entry.type === 'dir' || (entry.type === 'symlink' && entry.category === 'directory');
}

export function entryKindKey(entry: FileEntryDto): string {
  const symlink = entry.type === 'symlink' || entry.isSymlink;
  return `explorer.kind.${symlink ? 'symlink' : entry.category}`;
}

export function toEntryView(entry: FileEntryDto): ExplorerEntryView {
  return { entry, hidden: isHiddenName(entry.name), kindKey: entryKindKey(entry) };
}

function compareName(a: FileEntryDto, b: FileEntryDto): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

// 空值恒排最后，不随方向翻转。
function compareNullable(a: number | null, b: number | null, sign: number): number {
  if (a === null || b === null) {
    if (a === b) return 0;
    return a === null ? 1 : -1;
  }
  return (a - b) * sign;
}

function modifiedTime(entry: FileEntryDto): number | null {
  if (entry.modifiedAt === null) return null;
  const time = Date.parse(entry.modifiedAt);
  return Number.isNaN(time) ? null : time;
}

function compareCategory(a: FileEntryDto, b: FileEntryDto): number {
  if (a.category === b.category) return 0;
  return a.category < b.category ? -1 : 1;
}

type KeyComparator = (a: FileEntryDto, b: FileEntryDto, sign: number) => number;

const KEY_COMPARATORS: Record<ExplorerSortKey, KeyComparator> = {
  name: (a, b, sign) => compareName(a, b) * sign,
  size: (a, b, sign) => compareNullable(a.size, b.size, sign),
  modifiedAt: (a, b, sign) => compareNullable(modifiedTime(a), modifiedTime(b), sign),
  kind: (a, b, sign) => compareCategory(a, b) * sign,
};

/** 目录恒在前；方向只在目录组、文件组各自内部生效；主键相同按名称升序。 */
export function sortEntries(entries: readonly FileEntryDto[], sort: ExplorerSort): FileEntryDto[] {
  const compareKey = KEY_COMPARATORS[sort.key];
  const sign = sort.dir === 'desc' ? -1 : 1;
  return [...entries].sort((a, b) => {
    const dirA = isDirectoryEntry(a);
    if (dirA !== isDirectoryEntry(b)) return dirA ? -1 : 1;
    return compareKey(a, b, sign) || compareName(a, b);
  });
}

export function filterEntries(
  entries: readonly FileEntryDto[],
  opts: { showHidden: boolean; query: string }
): FileEntryDto[] {
  const query = opts.query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (!opts.showHidden && isHiddenName(entry.name)) return false;
    return query === '' || entry.name.toLowerCase().includes(query);
  });
}

/** 从 `fromIndex`（含）起找第一个名称以 `prefix` 开头的条目，到末尾后回绕；没有返回 -1。 */
export function typeAheadMatch(
  entries: readonly FileEntryDto[],
  prefix: string,
  fromIndex: number
): number {
  const count = entries.length;
  const needle = prefix.toLowerCase();
  if (count === 0 || needle === '') return -1;
  const start = Number.isInteger(fromIndex) ? ((fromIndex % count) + count) % count : 0;
  for (let step = 0; step < count; step += 1) {
    const index = (start + step) % count;
    if (entries[index].name.toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}
