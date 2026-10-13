// 浏览器组合层用到的纯推导：状态栏数字、返回上级后该选中谁、剪贴板与目标目录的已知信息。

import type { FileEntryDto, FileRootDto, ListFilesResponse } from '@vibeterm/shared';
import { basename } from '@vibeterm/shared';
import type { ExplorerClipboard } from '@vibeterm/stores';
import { isPathWithin } from '@vibeterm/stores';
import { isDirectoryEntry } from './model';

export interface ExplorerLocationRef {
  rootId: string;
  path: string;
}

export interface ExplorerStatus {
  total: number;
  selectedCount: number;
  /** 选中项里有目录或大小未知的条目时为 null */
  selectedBytes: number | null;
  truncated: boolean;
}

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function selectedEntriesOf(
  entries: readonly FileEntryDto[],
  selected: ReadonlySet<string>
): FileEntryDto[] {
  if (selected.size === 0) return [];
  return entries.filter((entry) => selected.has(entry.path));
}

export function selectedBytesOf(selected: readonly FileEntryDto[]): number | null {
  if (selected.length === 0) return null;
  let total = 0;
  for (const entry of selected) {
    if (isDirectoryEntry(entry) || entry.size === null) return null;
    total += entry.size;
  }
  return total;
}

export function explorerStatus(
  entries: readonly FileEntryDto[],
  selected: ReadonlySet<string>,
  truncated: boolean
): ExplorerStatus {
  const picked = selectedEntriesOf(entries, selected);
  return {
    total: entries.length,
    selectedCount: picked.length,
    selectedBytes: selectedBytesOf(picked),
    truncated,
  };
}

/**
 * 从 `previous` 回到它的某个祖先 `next`（上一级 / 后退）时，应该选中的那个直接子目录；
 * 其它情况（进入子目录、换根、平级跳转）返回 null。
 */
export function childToReselect(
  previous: ExplorerLocationRef | null,
  next: ExplorerLocationRef
): string | null {
  if (!previous || previous.rootId !== next.rootId || previous.path === next.path) return null;
  if (!isPathWithin(previous.path, next.path)) return null;
  const rest = previous.path.slice(next.path === '/' ? 1 : next.path.length + 1);
  const [name] = rest.split('/');
  return name ? joinPath(next.path, name) : null;
}

const EMPTY_PATHS: ReadonlySet<string> = new Set<string>();

/** 剪切态只在产生它的那个节点 + 根上显示。 */
export function cutPathsOf(
  clipboard: ExplorerClipboard | null,
  nodeId: string,
  rootId: string
): ReadonlySet<string> {
  if (!clipboard || clipboard.mode !== 'cut') return EMPTY_PATHS;
  if (clipboard.nodeId !== nodeId || clipboard.rootId !== rootId) return EMPTY_PATHS;
  return new Set(clipboard.paths);
}

export interface ClipboardItems {
  names: string[];
  hasDirectory: boolean;
}

/** 剪贴板里各项的名称；类型只有在它们恰好都在 `known` 里时才确定，否则保守地当作含目录。 */
export function clipboardItems(
  clipboard: ExplorerClipboard,
  known: readonly FileEntryDto[]
): ClipboardItems {
  const byPath = new Map(known.map((entry) => [entry.path, entry]));
  let hasDirectory = false;
  for (const path of clipboard.paths) {
    const entry = byPath.get(path);
    if (!entry || isDirectoryEntry(entry)) {
      hasDirectory = true;
      break;
    }
  }
  return { names: clipboard.paths.map((path) => basename(path)), hasDirectory };
}

/** 目录里已有的名称；列表没拿到或被截断（不完整）时为 null。 */
export function listingNames(
  listing: Pick<ListFilesResponse, 'entries' | 'truncated'> | undefined
): ReadonlySet<string> | null {
  if (!listing || listing.truncated) return null;
  return new Set(listing.entries.map((entry) => entry.name));
}

/** 放置提示里显示的目标目录名：根目录用根的展示名。 */
export function destDisplayName(dir: string, root: Pick<FileRootDto, 'path' | 'name'>): string {
  return dir === root.path ? root.name : basename(dir);
}

/** 多选时「打开」作用在键盘光标所在项上；光标不在选中项里则取第一项。 */
export function primaryEntry(
  selected: readonly FileEntryDto[],
  focus: string | null
): FileEntryDto | null {
  return selected.find((entry) => entry.path === focus) ?? selected[0] ?? null;
}

export type ExplorerContentKind = 'loading' | 'error' | 'empty' | 'filtered' | 'view';

export interface ContentKindInput {
  loaded: boolean;
  failed: boolean;
  total: number;
  visible: number;
  hasPendingFolder: boolean;
}

export function contentKindOf(input: ContentKindInput): ExplorerContentKind {
  if (!input.loaded) return input.failed ? 'error' : 'loading';
  if (input.visible > 0 || input.hasPendingFolder) return 'view';
  // 有条目但全被筛选 / 隐藏规则挡掉
  return input.total > 0 ? 'filtered' : 'empty';
}

/** 右键点在选中项上 → 作用于整个选择；点在未选中项上 → 只作用于它（视图会同步把它选中）。 */
export function menuEntriesOf(
  entry: FileEntryDto,
  selectedEntries: readonly FileEntryDto[]
): readonly FileEntryDto[] {
  return selectedEntries.some((item) => item.path === entry.path) ? selectedEntries : [entry];
}
