// 文件行 → entry 的解析：行在 DOM 上只留自身绝对路径，所属根与所在目录由外层列表容器带；
// 树根的共享右键菜单据此从目录列表的查询缓存里取回 entry，行本身不再持有回调或菜单。

import type { FileEntryDto, FileRootDto, ListFilesResponse } from '@tmex/shared';

export const FILE_LIST_ROOT_ATTR = 'data-file-list-root';
export const FILE_LIST_DIR_ATTR = 'data-file-list-dir';
export const FILE_LEAF_PATH_ATTR = 'data-file-leaf-path';

export interface FileLeafTarget {
  root: FileRootDto;
  entry: FileEntryDto;
}

export interface FileLeafRef {
  rootId: string;
  dir: string;
  path: string;
}

/** `Element` 的最小子集：无 DOM 环境下可用普通对象替身单测 */
export interface AttrElement {
  closest(selector: string): AttrElement | null;
  getAttribute(name: string): string | null;
}

/** 事件目标所在的文件行元素（含目标自身），不在文件行内为 null */
export function closestFileLeaf(target: AttrElement | null): AttrElement | null {
  return target?.closest(`[${FILE_LEAF_PATH_ATTR}]`) ?? null;
}

export function readFileLeafRef(leaf: AttrElement | null): FileLeafRef | null {
  const path = leaf?.getAttribute(FILE_LEAF_PATH_ATTR);
  if (!leaf || !path) return null;
  const list = leaf.closest(`[${FILE_LIST_ROOT_ATTR}]`);
  const rootId = list?.getAttribute(FILE_LIST_ROOT_ATTR);
  const dir = list?.getAttribute(FILE_LIST_DIR_ATTR);
  if (!rootId || dir === null || dir === undefined) return null;
  return { rootId, dir, path };
}

export function resolveFileLeafTarget(
  ref: FileLeafRef | null,
  roots: readonly FileRootDto[],
  listing: (rootId: string, dir: string) => ListFilesResponse | undefined
): FileLeafTarget | null {
  if (!ref) return null;
  const root = roots.find((candidate) => candidate.id === ref.rootId);
  if (!root) return null;
  const entry = listing(ref.rootId, ref.dir)?.entries.find((item) => item.path === ref.path);
  if (!entry || entry.type === 'dir') return null;
  return { root, entry };
}
