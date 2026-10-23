// 预览页「上一个 / 下一个」的同目录兄弟选取：顺序与文件管理器完全一致（目录置顶、工作区排序键、
// 隐藏文件开关），只在可预览的文件之间跳转。纯函数，列表与排序设置由调用方传入。

import { filterEntries, isDirectoryEntry, sortEntries } from '@vibeterm/panels/explorer/model';
import type { FileEntryDto } from '@vibeterm/shared';
import type { ExplorerSort } from '@vibeterm/stores';
import { PREVIEWABLE_CATEGORIES } from './preview-categories';

export interface SiblingFiles {
  /** 列表里的当前文件：stat 还没回来时，预览页先靠它知道类别 */
  current: FileEntryDto;
  prev: FileEntryDto | null;
  next: FileEntryDto | null;
}

export interface SiblingOptions {
  sort: ExplorerSort;
  showHidden: boolean;
}

/**
 * 当前文件不在列表里（已被删除 / 改名 / 列表被截断）返回 null。
 * 当前文件本身即使被隐藏开关挡住也保留，作为定位点——用户可以从一个隐藏文件出发看它的邻居。
 */
export function pickSiblings(
  entries: readonly FileEntryDto[],
  currentPath: string,
  options: SiblingOptions
): SiblingFiles | null {
  const visible = new Set(filterEntries(entries, { showHidden: options.showHidden, query: '' }));
  const files = sortEntries(
    entries.filter((entry) => entry.path === currentPath || visible.has(entry)),
    options.sort
  ).filter((entry) => !isDirectoryEntry(entry));

  const index = files.findIndex((entry) => entry.path === currentPath);
  if (index < 0) return null;
  const previewable = (entry: FileEntryDto) => PREVIEWABLE_CATEGORIES.has(entry.category);
  return {
    current: files[index],
    prev: files.slice(0, index).reverse().find(previewable) ?? null,
    next: files.slice(index + 1).find(previewable) ?? null,
  };
}
