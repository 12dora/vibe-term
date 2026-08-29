// 节点条目的拖拽外壳：在容器（根层 / 分组）的有序列表里参与排序。
//
// 把手不再由外壳自己贴在条目左侧，而是作为 `dragControls` 交给宿主放进节点头部——
// 「节点头（名称 / 在线态 / 把手）」才是被拖动的单元，卡片网格只是节点的内容。
//
// 没有「移出分组」按钮：把节点拖到所有分组虚线框之外的空白处松手就回到最外层。

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@tmex/ui';
import { GripVertical } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SortableItemData } from './collision';
import { nodeElementId } from './folder-tree-model';

const CONTROL_CLASS =
  'inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/90 text-muted-foreground shadow-sm transition-colors duration-(--tmex-motion-fast) ease-out hover:bg-accent hover:text-foreground motion-reduce:transition-none';

export interface DeviceFolderNodeShellProps {
  nodeId: string;
  /** 所在容器（根 / 分组）的 id：碰撞判定按容器筛兄弟，靠它认领 */
  containerId: string;
  disabled?: boolean;
  className?: string;
  /** 拿到把手后渲染节点本体 */
  children: (dragControls: ReactNode) => ReactNode;
}

export function DeviceFolderNodeShell({
  nodeId,
  containerId,
  disabled,
  className,
  children,
}: DeviceFolderNodeShellProps) {
  const { t } = useTranslation();
  const data = useMemo<SortableItemData>(() => ({ containerId }), [containerId]);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: nodeElementId(nodeId), data, disabled });

  const dragControls = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      data-testid={`device-folder-handle-${nodeId}`}
      aria-label={t('devices.folders.dragHandle')}
      title={t('devices.folders.dragHandle')}
      className={cn(CONTROL_CLASS, 'cursor-grab touch-none active:cursor-grabbing')}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-3.5" />
    </button>
  );

  // 宿主决定不渲染这个节点（mesh 列表里已经没有它）时连外壳一起省掉，不留空行
  const content = children(dragControls);
  if (content === null || content === undefined || content === false) return null;
  return (
    <div
      ref={setNodeRef}
      data-testid={`device-folder-item-node:${nodeId}`}
      data-dragging={isDragging ? 'true' : undefined}
      className={cn('min-w-0', isDragging && 'opacity-40 motion-reduce:opacity-40', className)}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      {content}
    </div>
  );
}
