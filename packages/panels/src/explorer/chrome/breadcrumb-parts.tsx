// 面包屑的零件：根目录切换、折叠菜单、可编辑地址栏。

import type { FileRootDto } from '@vibeterm/shared';
import { cn } from '@vibeterm/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@vibeterm/ui/dropdown-menu';
import { Input } from '@vibeterm/ui/input';
import { Check, ChevronDown, Folder, MoreHorizontal } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ExplorerCrumb, resolveTypedPath } from './crumb-model';
import { isImeKeyEvent } from './ime';

const CRUMB_BASE_CLASS =
  'inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-xs outline-none transition-[color,background-color,box-shadow] duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring/50';

export interface CrumbClassOptions {
  current: boolean;
  interactive: boolean;
  dropOver?: boolean;
}

// 宽度由 fitCrumbs 按量得的自然宽度分配，这里只给自然宽度封顶；当前目录的上限更宽
export function crumbClass({ current, interactive, dropOver }: CrumbClassOptions): string {
  return cn(
    CRUMB_BASE_CLASS,
    current ? 'max-w-64 font-medium text-foreground' : 'max-w-40 text-muted-foreground',
    interactive &&
      'hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground',
    dropOver && 'vibeterm-explorer-drop bg-primary/10 text-foreground ring-1 ring-primary/40'
  );
}

/** 压缩后的宽度上限；null 表示按自然宽度 */
export function crumbWidthStyle(maxWidth: number | null): CSSProperties | undefined {
  return maxWidth === null ? undefined : { maxWidth };
}

export interface RootChoice {
  roots: readonly FileRootDto[];
  rootId: string;
  onSelect(rootId: string): void;
}

function RootOptions({ roots, rootId, onSelect }: RootChoice) {
  return (
    <>
      {roots.map((root) => (
        <DropdownMenuItem
          key={root.id}
          data-testid={`explorer-root-option-${root.id}`}
          onClick={() => onSelect(root.id)}
        >
          <Check className={cn('size-3.5', root.id !== rootId && 'invisible')} />
          <span className={cn('min-w-0 truncate', root.id === rootId && 'font-medium')}>
            {root.name}
          </span>
          {root.deviceName && (
            <span className="ml-auto shrink-0 pl-3 text-[11px] text-muted-foreground">
              {root.deviceName}
            </span>
          )}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** 根这一级的下拉内容（不含触发器文字），量宽度的影子节点复用同一份标记 */
export function RootCrumbLabel({ rootName }: { rootName: string }) {
  return (
    <>
      <span className="truncate">{rootName}</span>
      <ChevronDown className="size-3 shrink-0 opacity-60" />
    </>
  );
}

export interface RootSwitcherProps extends RootChoice {
  rootName: string;
  className: string;
  style?: CSSProperties;
  testId: string;
}

export function RootSwitcher({ rootName, className, style, testId, ...choice }: RootSwitcherProps) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid={testId}
        data-root-switcher=""
        title={t('explorer.toolbar.root')}
        className={className}
        style={style}
      >
        <RootCrumbLabel rootName={rootName} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-48 max-w-[80vw]">
        <RootOptions {...choice} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface HiddenCrumbsMenuProps {
  crumbs: readonly ExplorerCrumb[];
  /** 根也被收进来且可切换时给出：菜单顶部列出全部根，保证切换入口仍可达 */
  rootChoice?: RootChoice;
  onNavigate(path: string): void;
}

export function HiddenCrumbsMenu({ crumbs, rootChoice, onNavigate }: HiddenCrumbsMenuProps) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="explorer-crumb-overflow"
        aria-label={t('explorer.toolbar.more')}
        className={crumbClass({ current: false, interactive: true })}
      >
        <MoreHorizontal className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-40 max-w-[80vw]">
        {rootChoice && <RootOptions {...rootChoice} />}
        {rootChoice && crumbs.length > 0 && <DropdownMenuSeparator />}
        {crumbs.map((crumb) => (
          <DropdownMenuItem key={crumb.path} onClick={() => onNavigate(crumb.path)}>
            <Folder className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 truncate">{crumb.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface BreadcrumbPathInputProps {
  rootPath: string;
  path: string;
  onNavigate(path: string): void;
  /** `restoreFocus`：键盘收起时把焦点还给编辑入口 */
  onClose(restoreFocus: boolean): void;
}

export function BreadcrumbPathInput({
  rootPath,
  path,
  onNavigate,
  onClose,
}: BreadcrumbPathInputProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(path);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const next = resolveTypedPath(draft, rootPath, path);
    if (next === null) {
      setInvalid(true);
      return;
    }
    onClose(next === path);
    if (next !== path) onNavigate(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 输入法选词时的 Enter / Escape 属于输入法，不提交也不取消
    if (isImeKeyEvent(event)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose(true);
  };

  return (
    <Input
      ref={inputRef}
      data-testid="explorer-path-input"
      aria-label={t('explorer.toolbar.editPath')}
      aria-invalid={invalid || undefined}
      className="h-7 min-w-0 flex-1 rounded-md px-2 font-mono text-xs md:text-xs"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        setInvalid(false);
      }}
      onKeyDown={handleKeyDown}
      onBlur={() => onClose(false)}
    />
  );
}
