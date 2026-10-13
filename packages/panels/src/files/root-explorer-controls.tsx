// 侧栏通往文件管理器的入口：根行尾部的「打开 / 关闭」按钮，以及目录菜单里的「在文件管理器中打开」。

import type { FileRootDto } from '@vibeterm/shared';
import { EXPLORER_ROUTE } from '@vibeterm/stores';
import { getExplorerStore, isExplorerRootOpen, useExplorerStore } from '@vibeterm/stores/explorer';
import { useRuntime } from '@vibeterm/stores/react';
import { cn } from '@vibeterm/ui';
import { useSidebar } from '@vibeterm/ui/sidebar';
import { Globe } from 'lucide-react';
import { type MouseEvent, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

/** 在文件管理器里打开（或切到已开着的）该位置；移动端顺手收起侧栏，与打开文件一致。 */
export function useOpenInExplorer(): (rootId: string, path: string) => void {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  return useCallback(
    (rootId: string, path: string) => {
      getExplorerStore().getState().openLocation({ nodeId: runtime.nodeId, rootId, path });
      // 文件管理器路由不带 node 前缀，不走 hostAppPath
      navigate(EXPLORER_ROUTE);
      if (isMobile) setOpenMobile(false);
    },
    [runtime.nodeId, navigate, isMobile, setOpenMobile]
  );
}

/** 根行尾部：SSH 设备的小地球（悬停看设备名）+「打开 / 关闭」文件管理器按钮。 */
export function RootExplorerControls({ root }: { root: FileRootDto }) {
  const { t } = useTranslation();
  const { nodeId } = useRuntime();
  const isOpen = useExplorerStore((state) => isExplorerRootOpen(state, nodeId, root.id));
  const openInExplorer = useOpenInExplorer();

  const onClick = (event: MouseEvent) => {
    // 按钮与行内的展开钮是兄弟节点，这里拦住冒泡只为不惊动树根的事件委托
    event.stopPropagation();
    if (isOpen) getExplorerStore().getState().closeLocation(nodeId, root.id);
    else openInExplorer(root.id, root.path);
  };

  const deviceName = root.deviceName ?? root.deviceId;
  return (
    <span className="flex shrink-0 items-center gap-1 pr-1">
      {root.deviceType === 'ssh' && (
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
      <button
        type="button"
        data-state={isOpen ? 'open' : 'closed'}
        data-testid={`file-root-explorer-${root.id}`}
        onClick={onClick}
        className={cn(
          'h-5 rounded px-1.5 text-[11px] transition-colors hover:bg-sidebar-accent-foreground/10',
          isOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
        )}
      >
        {isOpen ? t('files.explorer.close') : t('files.explorer.open')}
      </button>
    </span>
  );
}
