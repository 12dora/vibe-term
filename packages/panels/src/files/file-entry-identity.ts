// 目录列表刷新后的 entry 引用稳定化。
//
// react-query 的 structural sharing 只按下标逐位比对：目录里插入/删除一个文件，插入点之后
// 的每一个 entry 都会拿到新对象，哪怕内容一字未改——500 行的目录于是整片打穿行级 memo。
// 这里按路径复用上一份里内容相同的 entry；整份逐位不变时连数组引用一起沿用。

import type { FileEntryDto } from '@tmex/shared';

/** 行渲染与右键菜单实际读到的字段全等即视为同一份 */
export function sameFileEntry(a: FileEntryDto, b: FileEntryDto): boolean {
  return (
    a.path === b.path &&
    a.name === b.name &&
    a.type === b.type &&
    a.category === b.category &&
    a.size === b.size &&
    a.modifiedAt === b.modifiedAt &&
    a.isSymlink === b.isSymlink
  );
}

function pickPrevious(
  candidate: FileEntryDto,
  slot: FileEntryDto | undefined,
  byPath: Map<string, FileEntryDto>
): FileEntryDto {
  if (slot && sameFileEntry(slot, candidate)) return slot;
  const moved = byPath.get(candidate.path);
  return moved && sameFileEntry(moved, candidate) ? moved : candidate;
}

export function stabilizeFileEntries(
  previous: readonly FileEntryDto[] | undefined,
  next: readonly FileEntryDto[]
): readonly FileEntryDto[] {
  if (!previous || previous === next || previous.length === 0) return next;

  const byPath = new Map<string, FileEntryDto>();
  for (const entry of previous) byPath.set(entry.path, entry);

  const out: FileEntryDto[] = new Array(next.length);
  let reused = false;
  let identical = previous.length === next.length;
  for (let i = 0; i < next.length; i += 1) {
    const picked = pickPrevious(next[i] as FileEntryDto, previous[i], byPath);
    out[i] = picked;
    if (picked !== next[i]) reused = true;
    if (picked !== previous[i]) identical = false;
  }

  if (identical) return previous;
  return reused ? out : next;
}
