import type { FileEntryDto, FileStatResponse } from '@vibeterm/shared';

/** 预览页只有 stat；传输流程要的是列表条目形状。path 用路由里的路径（与查看器一致）。 */
export function fileEntryFromStat(stat: FileStatResponse, path: string): FileEntryDto {
  return {
    name: stat.name,
    path,
    type: stat.type,
    category: stat.category,
    size: stat.size,
    modifiedAt: stat.modifiedAt,
    isSymlink: stat.isSymlink,
  };
}
