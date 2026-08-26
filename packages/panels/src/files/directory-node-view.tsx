// 目录节点的呈现层：可拖入上传的行 + 右键菜单 + 隐藏的文件选择框；子节点由调用方传入。

import type { FileRootDto } from '@tmex/shared';
import { cn } from '@tmex/ui';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@tmex/ui/context-menu';
import { ChevronRight, ChevronsUpDown, Upload } from 'lucide-react';
import type { ChangeEvent, ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { fileIconColor, fileIconFor } from './file-icon';
import { nodeBasename } from './file-tree-logic';
import { CommonNodeMenuItems, DeviceBadge, NodeMenuHeader } from './node-menu';
import type { DropZoneProps } from './use-directory-upload';

export interface DirectoryNodeViewProps {
  root: FileRootDto;
  rootId: string;
  path: string;
  indent: number;
  isRoot: boolean;
  expanded: boolean;
  dragActive: boolean;
  onToggle: () => void;
  dropZoneProps: DropZoneProps;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPickFiles: () => void;
  onFileInputChange: (e: ChangeEvent<HTMLInputElement>) => void;
  children: ReactNode;
}

export function DirectoryNodeView({
  root,
  rootId,
  path,
  indent,
  isRoot,
  expanded,
  dragActive,
  onToggle,
  dropZoneProps,
  fileInputRef,
  onPickFiles,
  onFileInputChange,
  children,
}: DirectoryNodeViewProps) {
  const { t } = useTranslation();
  const Icon = fileIconFor({ category: 'directory', name: root.name, type: 'dir' }, { expanded });

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <button
              type="button"
              onClick={onToggle}
              {...dropZoneProps}
              data-testid={`file-dir-${rootId}-${path}`}
              style={{ paddingLeft: indent }}
              className={cn(
                'flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent data-[pressed]:bg-sidebar-accent [@media(any-pointer:coarse)]:py-1.5',
                isRoot ? 'font-medium text-foreground' : 'text-foreground',
                dragActive && 'bg-primary/15 ring-1 ring-primary/40 ring-inset'
              )}
            >
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                  expanded && 'rotate-90'
                )}
              />
              <Icon
                className={cn(
                  'h-4 w-4 shrink-0',
                  isRoot ? 'text-muted-foreground' : fileIconColor('directory')
                )}
              />
              <span className="min-w-0 flex-1 truncate text-xs">
                {isRoot ? root.name : nodeBasename(path)}
              </span>
              {isRoot && <DeviceBadge root={root} />}
            </button>
          }
        />
        <ContextMenuContent>
          <NodeMenuHeader root={root} absPath={path} />
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onToggle}>
            <ChevronsUpDown />
            {expanded ? t('files.menu.collapse') : t('files.menu.expand')}
          </ContextMenuItem>
          <ContextMenuItem onClick={onPickFiles}>
            <Upload />
            {t('files.menu.upload')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <CommonNodeMenuItems deviceId={root.deviceId} absPath={path} rootPath={root.path} />
        </ContextMenuContent>
      </ContextMenu>
      <input ref={fileInputRef} type="file" multiple hidden onChange={onFileInputChange} />

      {expanded && <div>{children}</div>}
    </div>
  );
}
