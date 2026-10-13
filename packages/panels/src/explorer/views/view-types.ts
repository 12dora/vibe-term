// 列表 / 图标两种视图共用的属性契约：视图只负责呈现与手势，状态全部由上层持有。

import type { FileEntryDto } from '@vibeterm/shared';
import type { ExplorerSort } from '@vibeterm/stores';
import type { DragEvent, MouseEvent } from 'react';
import type { SelectionState } from '../model/selection';

export interface ExplorerViewProps {
  /** 已筛选、已排序 */
  entries: readonly FileEntryDto[];
  selection: SelectionState;
  /** 被剪切的条目，半透明显示 */
  cutPaths: ReadonlySet<string>;
  /** 该行的名称换成行内编辑框 */
  renamingPath: string | null;
  /** 新建文件夹的占位行，带行内编辑框，排在最前 */
  pendingFolder: { name: string } | null;
  /** 列表视图表头用 */
  sort: ExplorerSort;
  /** 当前高亮为放置目标的文件夹行 */
  dropTargetPath: string | null;
  /** 触屏：单击即打开，行首显示复选框 */
  coarsePointer: boolean;
  onSortChange(sort: ExplorerSort): void;
  onSelectionChange(next: SelectionState): void;
  /** 双击（触屏为单击） */
  onOpen(entry: FileEntryDto): void;
  /** entry 为 null 表示空白处 */
  onContextMenu(entry: FileEntryDto | null, event: MouseEvent): void;
  onRenameCommit(path: string, name: string): void;
  onRenameCancel(): void;
  onPendingFolderCommit(name: string): void;
  onPendingFolderCancel(): void;
  onItemDragStart(entry: FileEntryDto, event: DragEvent): void;
  onItemDragEnd(event: DragEvent): void;
  /** 拖到文件夹行（path）或空白处（null）上方 / 放下 */
  onDragOverTarget(path: string | null, event: DragEvent): void;
  onDropTarget(path: string | null, event: DragEvent): void;
  onDragLeaveAll(): void;
}
