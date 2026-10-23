// 侧栏通往文件管理器的入口：每个文件夹行（含根行）尾部的「打开 / 关闭」按钮，
// 以及目录菜单里的「在文件管理器中打开」共用的 useOpenInExplorer。
//
// 「打开」= 文件管理器里有标签页正停在这个目录（node + root + 路径精确相等）；
// 点「打开」聚焦已有标签页或新开一个，点「关闭」关掉正停在这个目录的标签页。

import type { FileRootDto } from '@vibeterm/shared';
import {
  getExplorerStore,
  isExplorerLocationOpen,
  useExplorerStore,
} from '@vibeterm/stores/explorer';
import { useRuntime } from '@vibeterm/stores/react';
import { cn } from '@vibeterm/ui';
import { Globe } from 'lucide-react';
import { type MouseEvent, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { openExplorerAt } from './open-explorer';

/** 在文件管理器里打开（或切到已开着的）该位置；宿主导航会顺带收起手机端侧栏。 */
export function useOpenInExplorer(): (rootId: string, path: string) => void {
  const runtime = useRuntime();
  return useCallback(
    (rootId: string, path: string) => openExplorerAt(runtime, rootId, path),
    [runtime]
  );
}

// 子目录行的按钮平时隐去，悬停 / 键盘聚焦到行内时现身；触屏没有悬停，常显。已「打开」的恒显。
const REVEAL_ON_ROW_ACTIVE =
  'opacity-0 transition-opacity group-hover/dir-row:opacity-100 group-focus-within/dir-row:opacity-100 [@media(any-pointer:coarse)]:opacity-100';

export interface FolderExplorerControlProps {
  root: FileRootDto;
  /** 这一行代表的目录（根行即根路径）。 */
  path: string;
  /** 文件夹显示名：读屏时用来区分各行同样写着「打开」的按钮。 */
  name: string;
  isRoot: boolean;
}

function ExplorerOpenButton({ root, path, name, isRoot }: FolderExplorerControlProps) {
  const { t } = useTranslation();
  const { nodeId } = useRuntime();
  const isOpen = useExplorerStore((state) =>
    isExplorerLocationOpen(state, { nodeId, rootId: root.id, path })
  );
  const openInExplorer = useOpenInExplorer();

  const onClick = (event: MouseEvent) => {
    // 按钮与行内的展开钮是兄弟节点，这里拦住冒泡只为不惊动行 / 树根的事件委托
    event.stopPropagation();
    if (isOpen) getExplorerStore().getState().closeLocation({ nodeId, rootId: root.id, path });
    else openInExplorer(root.id, path);
  };

  // 根行沿用既有 testid（e2e 依赖）
  const testId = isRoot ? `file-root-explorer-${root.id}` : `file-dir-explorer-${root.id}-${path}`;

  return (
    <button
      type="button"
      data-state={isOpen ? 'open' : 'closed'}
      data-testid={testId}
      onClick={onClick}
      aria-label={t(isOpen ? 'files.explorer.closeNamed' : 'files.explorer.openNamed', { name })}
      className={cn(
        'h-5 shrink-0 rounded px-1.5 text-[11px] transition-colors hover:bg-sidebar-accent-foreground/10',
        isOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
        !isRoot && !isOpen && REVEAL_ON_ROW_ACTIVE
      )}
    >
      {isOpen ? t('files.explorer.close') : t('files.explorer.open')}
    </button>
  );
}

/** 文件夹行尾部：（根行：SSH 设备的小地球，悬停看设备名）+「打开 / 关闭」按钮。 */
export function FolderExplorerControl(props: FolderExplorerControlProps) {
  const { root, isRoot } = props;
  const deviceName = root.deviceName ?? root.deviceId;
  return (
    <span className="flex shrink-0 items-center gap-1 pr-1">
      {isRoot && root.deviceType === 'ssh' && (
        <span
          role="img"
          title={deviceName}
          aria-label={deviceName}
          data-testid={`file-root-remote-${root.id}`}
          className="flex items-center text-muted-foreground/70"
        >
          <Globe className="h-3 w-3" />
        </span>
      )}
      <ExplorerOpenButton {...props} />
    </span>
  );
}
