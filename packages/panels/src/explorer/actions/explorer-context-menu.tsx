// 文件管理器的右键菜单：整个浏览器只挂一个 ContextMenu，由 `anchor`（视口坐标）命令式打开。
//
// 与侧栏 `file-leaf-menu.tsx` 同一套机制：Trigger 是一个 0 尺寸、不接收指针的 fixed 锚点，
// `anchor` 变化时给它派发一次 `contextmenu`（坐标 = anchor），base-ui 的 Trigger 据此把
// 虚拟锚点（`getBoundingClientRect` 返回该点的 0 尺寸矩形）写进 ContextMenu.Root 并打开；
// 定位、Esc / 点外部关闭、焦点陷阱仍全是 base-ui 的原逻辑。

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@vibeterm/ui/context-menu';
import {
  ClipboardPaste,
  Copy,
  Download,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Link,
  ListChecks,
  type LucideIcon,
  PanelsTopLeft,
  Pencil,
  RotateCw,
  Scissors,
  Trash2,
  Upload,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isApplePlatform } from '../model/shortcuts';
import {
  type ExplorerMenuCommand,
  type ExplorerMenuItem,
  type ExplorerMenuSection,
  type ExplorerMenuTarget,
  buildExplorerMenu,
} from './menu-model';

export interface ExplorerContextMenuProps {
  /** 视口坐标；null = 关闭。`onClose` 触发后调用方应把它置回 null */
  anchor: { x: number; y: number } | null;
  target: ExplorerMenuTarget;
  canPaste: boolean;
  onCommand(command: ExplorerMenuCommand): void;
  onClose(): void;
}

const MENU_ICONS: Partial<Record<ExplorerMenuCommand, LucideIcon>> = {
  open: FolderOpen,
  openInNewTab: PanelsTopLeft,
  download: Download,
  cut: Scissors,
  copy: Copy,
  paste: ClipboardPaste,
  rename: Pencil,
  copyPath: Link,
  delete: Trash2,
  newFolder: FolderPlus,
  upload: Upload,
  uploadFolder: FolderUp,
  selectAll: ListChecks,
  refresh: RotateCw,
};

const MENU_CONTENT_SELECTOR = '[data-slot="context-menu-content"]';

function focusedElement(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

// 关闭后把焦点还给打开前的元素；但命令本身已经把焦点带到别处（如行内重命名输入框）时不抢。
function resolveFinalFocus(previous: HTMLElement | null): boolean | HTMLElement {
  const active = focusedElement();
  if (active && !active.closest(MENU_CONTENT_SELECTOR)) return false;
  return previous?.isConnected ? previous : true;
}

function MenuEntry({
  item,
  onCommand,
}: {
  item: ExplorerMenuItem;
  onCommand(command: ExplorerMenuCommand): void;
}) {
  const { t } = useTranslation();
  const Icon = MENU_ICONS[item.command];
  return (
    <ContextMenuItem
      variant={item.destructive ? 'destructive' : 'default'}
      disabled={item.disabled}
      data-testid={`explorer-menu-${item.command}`}
      onClick={() => onCommand(item.command)}
    >
      {Icon && <Icon />}
      {t(item.labelKey)}
      {item.shortcut && (
        <span className="ml-auto pl-6 text-[11px] tabular-nums text-muted-foreground">
          {item.shortcut}
        </span>
      )}
    </ContextMenuItem>
  );
}

/** 菜单内容：分组之间画分隔线。单独导出以便无 DOM 环境下做 SSR 快照 */
export function ExplorerMenuSections({
  sections,
  onCommand,
}: {
  sections: readonly ExplorerMenuSection[];
  onCommand(command: ExplorerMenuCommand): void;
}) {
  return (
    <>
      {sections.map((section, index) => (
        <Fragment key={section[0]?.command ?? 'empty'}>
          {index > 0 && <ContextMenuSeparator />}
          {section.map((item) => (
            <MenuEntry key={item.command} item={item} onCommand={onCommand} />
          ))}
        </Fragment>
      ))}
    </>
  );
}

export function ExplorerContextMenu({
  anchor,
  target,
  canPaste,
  onCommand,
  onClose,
}: ExplorerContextMenuProps) {
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [open, setOpen] = useState(false);

  const apple = useMemo(isApplePlatform, []);
  const liveSections = useMemo(
    () => buildExplorerMenu(target, { canPaste, apple }),
    [target, canPaste, apple]
  );
  // 关闭动画期间调用方往往已经换了 target：沿用打开时的内容，避免退场时闪成另一份菜单
  const shownSectionsRef = useRef(liveSections);
  if (anchor) shownSectionsRef.current = liveSections;

  const x = anchor?.x;
  const y = anchor?.y;
  useEffect(() => {
    if (x === undefined || y === undefined) {
      setOpen(false);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;
    restoreFocusRef.current = focusedElement();
    trigger.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: x,
        clientY: y,
      })
    );
  }, [x, y]);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) onCloseRef.current();
  }, []);

  return (
    <ContextMenu open={open} onOpenChange={handleOpenChange}>
      <ContextMenuTrigger
        className="pointer-events-none fixed top-0 left-0 h-0 w-0"
        render={<div ref={triggerRef} tabIndex={-1} />}
      />
      <ContextMenuContent
        data-testid="explorer-context-menu"
        finalFocus={() => resolveFinalFocus(restoreFocusRef.current)}
      >
        <ExplorerMenuSections sections={shownSectionsRef.current} onCommand={onCommand} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
