// 右键菜单里的文件操作项。只在菜单弹出时才挂载，所以这里的 hooks 不计入行的渲染成本。

import { ContextMenuItem, ContextMenuSeparator } from '@vibeterm/ui/context-menu';
import { FolderOpen, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFileOpsRequest } from './file-ops-host';
import { useOpenInExplorer } from './root-explorer-controls';

interface OpsTarget {
  rootId: string;
  path: string;
  name: string;
}

export function OpenInExplorerMenuItem({ rootId, path }: { rootId: string; path: string }) {
  const { t } = useTranslation();
  const openInExplorer = useOpenInExplorer();
  return (
    <ContextMenuItem onClick={() => openInExplorer(rootId, path)}>
      <FolderOpen />
      {t('files.menu.openInExplorer')}
    </ContextMenuItem>
  );
}

export function NewFolderMenuItem({ rootId, dir }: { rootId: string; dir: string }) {
  const { t } = useTranslation();
  const { requestNewFolder } = useFileOpsRequest();
  return (
    <ContextMenuItem onClick={() => requestNewFolder(rootId, dir)}>
      <FolderPlus />
      {t('files.menu.newFolder')}
    </ContextMenuItem>
  );
}

export function RenameMenuItem({ rootId, path, name, isDir }: OpsTarget & { isDir: boolean }) {
  const { t } = useTranslation();
  const { requestRename } = useFileOpsRequest();
  return (
    <ContextMenuItem onClick={() => requestRename(rootId, path, name, isDir)}>
      <Pencil />
      {t('files.menu.rename')}
    </ContextMenuItem>
  );
}

/** 破坏性操作固定收在菜单末尾，自带上方的分隔线。 */
export function DeleteMenuSection({ rootId, path, name }: OpsTarget) {
  const { t } = useTranslation();
  const { requestDelete } = useFileOpsRequest();
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onClick={() => requestDelete(rootId, [{ path, name }])}
      >
        <Trash2 />
        {t('files.menu.delete')}
      </ContextMenuItem>
    </>
  );
}
