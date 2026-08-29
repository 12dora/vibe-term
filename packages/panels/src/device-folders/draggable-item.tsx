// 条目（节点分组 / 单台设备卡片）的拖拽外壳。
//
// 两种形态：
//  - `sortable`：条目在某个容器的有序列表里（根层显式条目、文件夹内条目），参与同容器排序；
//  - `draggable`：条目还在节点分组的卡片网格里（没有 placement），只能被拖出去落到别处，
//    容器内顺序由设备自身的 sortOrder 决定，不进 SortableContext。

import { useDraggable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@tmex/ui';
import { CornerLeftUp, GripVertical } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface DeviceFolderItemShellProps {
  /** `deviceFolderItemKey(ref)` */
  itemKey: string;
  mode?: 'sortable' | 'draggable';
  disabled?: boolean;
  /** 提供时在把手旁显示「移出文件夹」按钮 */
  onMoveToRoot?: () => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

interface ShellBodyProps extends Omit<DeviceFolderItemShellProps, 'mode'> {
  setNodeRef: (node: HTMLElement | null) => void;
  setHandleRef: (node: HTMLElement | null) => void;
  handleProps: Record<string, unknown>;
  isDragging: boolean;
  dragStyle: CSSProperties;
}

const HANDLE_CLASS =
  'inline-flex size-6 items-center justify-center rounded-md border border-border/60 bg-background/90 text-muted-foreground opacity-0 shadow-sm transition-opacity duration-(--tmex-motion-fast) ease-out group-hover/folder-item:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none [@media(pointer:coarse)]:opacity-100';

function ShellBody({
  itemKey,
  onMoveToRoot,
  className,
  style,
  children,
  setNodeRef,
  setHandleRef,
  handleProps,
  isDragging,
  dragStyle,
}: ShellBodyProps) {
  const { t } = useTranslation();
  return (
    <div
      ref={setNodeRef}
      data-testid={`device-folder-item-${itemKey}`}
      data-dragging={isDragging ? 'true' : undefined}
      className={cn(
        'group/folder-item relative min-w-0 pl-5',
        isDragging && 'opacity-40 motion-reduce:opacity-40',
        className
      )}
      style={{ ...dragStyle, ...style }}
    >
      <div className="absolute left-0 top-1 z-10 flex flex-col gap-1">
        <button
          type="button"
          ref={setHandleRef}
          aria-label={t('devices.folders.dragHandle')}
          title={t('devices.folders.dragHandle')}
          className={cn(HANDLE_CLASS, 'cursor-grab touch-none active:cursor-grabbing')}
          {...handleProps}
        >
          <GripVertical className="size-3.5" />
        </button>
        {onMoveToRoot && (
          <button
            type="button"
            aria-label={t('devices.folders.moveToRoot')}
            title={t('devices.folders.moveToRoot')}
            className={HANDLE_CLASS}
            onClick={onMoveToRoot}
          >
            <CornerLeftUp className="size-3.5" />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function SortableItemShell(props: DeviceFolderItemShellProps) {
  const { itemKey, disabled } = props;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: itemKey, disabled });

  return (
    <ShellBody
      {...props}
      setNodeRef={setNodeRef}
      setHandleRef={setActivatorNodeRef}
      handleProps={{ ...attributes, ...listeners }}
      isDragging={isDragging}
      dragStyle={{ transform: CSS.Translate.toString(transform), transition }}
    />
  );
}

function DraggableItemShell(props: DeviceFolderItemShellProps) {
  const { itemKey, disabled } = props;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useDraggable({ id: itemKey, disabled });

  return (
    <ShellBody
      {...props}
      setNodeRef={setNodeRef}
      setHandleRef={setActivatorNodeRef}
      handleProps={{ ...attributes, ...listeners }}
      isDragging={isDragging}
      dragStyle={{ transform: CSS.Translate.toString(transform) }}
    />
  );
}

export function DeviceFolderItemShell({ mode = 'sortable', ...props }: DeviceFolderItemShellProps) {
  return mode === 'sortable' ? <SortableItemShell {...props} /> : <DraggableItemShell {...props} />;
}
