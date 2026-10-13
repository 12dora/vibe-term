// 浏览器里的临时界面状态：行内重命名、新建文件夹占位行、删除确认、快捷键面板、右键菜单、新条目高亮。
// 跟目录绑定的那几项在换目录时自动复位。

import type { FileEntryDto } from '@vibeterm/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ExplorerMenuTarget } from './actions';
import { useKeyedState } from './use-keyed-state';

/** 与 `vibeterm-explorer-flash` 的动画时长一致 */
export const EXPLORER_FLASH_MS = 900;

export interface ExplorerMenuState {
  anchor: { x: number; y: number } | null;
  target: ExplorerMenuTarget;
}

const CLOSED_MENU: ExplorerMenuState = { anchor: null, target: { kind: 'background' } };

export interface ExplorerDialogs {
  renamingPath: string | null;
  setRenamingPath(path: string | null): void;
  pendingFolder: { name: string } | null;
  setPendingFolder(folder: { name: string } | null): void;
  deleteTargets: readonly FileEntryDto[] | null;
  setDeleteTargets(targets: readonly FileEntryDto[] | null): void;
  shortcutsOpen: boolean;
  setShortcutsOpen(open: boolean): void;
  menu: ExplorerMenuState;
  openMenu(target: ExplorerMenuTarget, anchor: { x: number; y: number }): void;
  closeMenu(): void;
  flashPath: string | null;
  flash(path: string): void;
  /** 有我们自己的对话框 / 菜单开着：键盘快捷键让路 */
  overlayOpen: boolean;
}

export function useExplorerDialogs(locationKey: string): ExplorerDialogs {
  const [renamingPath, setRenamingPath] = useKeyedState<string | null>(locationKey, null);
  const [pendingFolder, setPendingFolder] = useKeyedState<{ name: string } | null>(
    locationKey,
    null
  );
  const [deleteTargets, setDeleteTargets] = useKeyedState<readonly FileEntryDto[] | null>(
    locationKey,
    null
  );
  const [flashPath, setFlashPath] = useKeyedState<string | null>(locationKey, null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [menu, setMenu] = useState<ExplorerMenuState>(CLOSED_MENU);

  useEffect(() => {
    if (flashPath === null) return;
    const timer = setTimeout(() => setFlashPath(null), EXPLORER_FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashPath, setFlashPath]);

  const openMenu = useCallback(
    (target: ExplorerMenuTarget, anchor: { x: number; y: number }) => setMenu({ target, anchor }),
    []
  );
  // 只收起锚点、保留 target：命令在菜单关闭的同一轮里执行，仍要读到它
  const closeMenu = useCallback(
    () => setMenu((current) => (current.anchor ? { ...current, anchor: null } : current)),
    []
  );

  const overlayOpen = deleteTargets !== null || shortcutsOpen || menu.anchor !== null;

  return useMemo(
    () => ({
      renamingPath,
      setRenamingPath,
      pendingFolder,
      setPendingFolder,
      deleteTargets,
      setDeleteTargets,
      shortcutsOpen,
      setShortcutsOpen,
      menu,
      openMenu,
      closeMenu,
      flashPath,
      flash: setFlashPath,
      overlayOpen,
    }),
    [
      renamingPath,
      setRenamingPath,
      pendingFolder,
      setPendingFolder,
      deleteTargets,
      setDeleteTargets,
      shortcutsOpen,
      menu,
      openMenu,
      closeMenu,
      flashPath,
      setFlashPath,
      overlayOpen,
    ]
  );
}
