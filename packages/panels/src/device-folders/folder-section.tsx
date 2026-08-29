// 一个分组：虚线边框的放置区，头部（把手 / 折叠箭头 / 名称 / 计数 / 操作菜单）+ 可折叠的内容区。
//
// 内容区用 `grid-template-rows: 0fr → 1fr` 做高度过渡（不需要测量真实高度），折叠期间靠
// visibility 一起过渡：展开时立刻可见、折叠时等动画走完再隐藏，收起后的内容不会留在 Tab 序里。

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DeviceFolder } from '@tmex/shared';
import { cn } from '@tmex/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import {
  ChevronRight,
  Folder,
  FolderOpen,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SortableItemData } from './collision';
import { useDropZone } from './drop-zone';
import { FolderNameEditor } from './folder-name-editor';
import {
  ROOT_CONTAINER_ID,
  dropZoneId,
  folderContainerId,
  folderElementId,
} from './folder-tree-model';

const COLLAPSE_UNMOUNT_FALLBACK_MS = 400;

export interface FolderSectionProps {
  folder: DeviceFolder;
  itemCount: number;
  expanded: boolean;
  renaming: boolean;
  dragDisabled: boolean;
  /** 当前拖拽命中的容器就是这个分组 */
  dropTarget: boolean;
  onToggle: (expanded: boolean) => void;
  onStartRename: () => void;
  onSubmitRename: (name: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
  children: ReactNode;
}

const HANDLE_CLASS =
  'inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity duration-(--tmex-motion-fast) ease-out group-hover/folder:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none [@media(pointer:coarse)]:opacity-100';

export function FolderSection({
  folder,
  itemCount,
  expanded,
  renaming,
  dragDisabled,
  dropTarget,
  onToggle,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  onDelete,
  children,
}: FolderSectionProps) {
  const { t } = useTranslation();
  // 折叠后内容区整体卸载（让其中的 droppable 一起释放），
  // 但要等收起过渡跑完再卸，reduced-motion 下没有 transitionend，用定时器兜底。
  const [contentMounted, setContentMounted] = useState(expanded);
  useEffect(() => {
    if (expanded) {
      setContentMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setContentMounted(false), COLLAPSE_UNMOUNT_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [expanded]);
  // 分组只在根层彼此排序：碰撞判定把它当作根容器的兄弟条目
  const data = useMemo<SortableItemData>(() => ({ containerId: ROOT_CONTAINER_ID }), []);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: folderElementId(folder.id), data, disabled: dragDisabled });
  const headerZone = useDropZone(dropZoneId(folderContainerId(folder.id)));

  return (
    <section
      ref={setNodeRef}
      data-testid={`device-folder-${folder.id}`}
      data-expanded={expanded ? 'true' : 'false'}
      data-dragging={isDragging ? 'true' : undefined}
      data-drop-target={dropTarget ? 'true' : undefined}
      className={cn(
        'group/folder min-w-0 rounded-xl border-2 border-dashed border-border/80 bg-muted/10 transition-[border-color,background-color,box-shadow] duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none',
        dropTarget && 'border-solid border-ring/70 bg-accent/40 ring-2 ring-ring/30',
        isDragging && 'opacity-40'
      )}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div
        ref={headerZone.ref}
        {...headerZone.props}
        className="flex min-w-0 items-center gap-1 rounded-t-xl px-1.5 py-1.5"
      >
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={t('devices.folders.dragHandle')}
          title={t('devices.folders.dragHandle')}
          className={cn(HANDLE_CLASS, 'cursor-grab touch-none active:cursor-grabbing')}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>

        {renaming ? (
          <FolderNameEditor
            testId="device-folder-rename-input"
            initialName={folder.name}
            className="min-w-0 flex-1"
            onSubmit={onSubmitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <>
            <button
              type="button"
              data-testid={`device-folder-toggle-${folder.id}`}
              aria-expanded={expanded}
              title={expanded ? t('devices.folders.collapse') : t('devices.folders.expand')}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={() => onToggle(!expanded)}
              onDoubleClick={onStartRename}
            >
              <ChevronRight
                className={cn(
                  'size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none',
                  expanded && 'rotate-90'
                )}
              />
              {expanded ? (
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span
                data-testid={`device-folder-name-${folder.id}`}
                className="min-w-0 truncate font-medium"
              >
                {folder.name}
              </span>
              <span
                data-testid={`device-folder-count-${folder.id}`}
                className="shrink-0 rounded border border-border/60 px-1.5 py-px text-[10px] leading-none text-muted-foreground"
              >
                {t('devices.folders.itemCount', { count: itemCount })}
              </span>
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    data-testid={`device-folder-menu-${folder.id}`}
                    aria-label={t('devices.folders.folderMenu')}
                    title={t('devices.folders.folderMenu')}
                    className={HANDLE_CLASS}
                  />
                }
              >
                <MoreHorizontal className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    data-testid={`device-folder-rename-${folder.id}`}
                    onClick={onStartRename}
                  >
                    <Pencil className="size-4" />
                    {t('devices.folders.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    data-testid={`device-folder-delete-${folder.id}`}
                    onClick={onDelete}
                  >
                    <Trash2 className="size-4" />
                    {t('devices.folders.delete')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      <div
        className="grid transition-[grid-template-rows] duration-(--tmex-motion-standard) ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && !expanded) setContentMounted(false);
        }}
      >
        <div
          aria-hidden={!expanded}
          className={cn(
            'overflow-hidden transition-[visibility] duration-(--tmex-motion-standard) motion-reduce:transition-none',
            !expanded && 'invisible'
          )}
        >
          <div className="flex min-w-0 flex-col gap-3 px-2 pb-2 pt-0.5">
            {contentMounted && children}
          </div>
        </div>
      </div>
    </section>
  );
}

export interface FolderDropAreaProps {
  /** droppable id（`dropZoneId` / `bodyDropZoneId`），全局唯一 */
  zoneId: string;
  label: string;
  /** 命中时换成更明确的文案（「放入某某」）；缺省沿用 label */
  activeLabel?: string;
  active: boolean;
  testId: string;
  className?: string;
}

/** 空分组 / 根层的落点提示：虚线框，拖拽命中时变实线高亮 */
export function FolderDropArea({
  zoneId,
  label,
  activeLabel,
  active,
  testId,
  className,
}: FolderDropAreaProps) {
  const zone = useDropZone(zoneId);
  return (
    <div
      ref={zone.ref}
      {...zone.props}
      data-testid={testId}
      data-drop-target={active ? 'true' : undefined}
      className={cn(
        'rounded-lg border-2 border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground transition-[background-color,border-color,box-shadow] duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none',
        active && 'border-solid border-ring/60 bg-accent/50 text-foreground ring-2 ring-ring/40',
        className
      )}
    >
      {active ? (activeLabel ?? label) : label}
    </div>
  );
}
