// 面包屑的零件：根目录切换、折叠菜单、可编辑地址栏。

import type { FileRootDto } from '@vibeterm/shared';
import { cn } from '@vibeterm/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibeterm/ui/dropdown-menu';
import { Input } from '@vibeterm/ui/input';
import { Check, ChevronDown, Folder, MoreHorizontal } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ExplorerCrumb, resolveTypedPath } from './crumb-model';

const CRUMB_BASE_CLASS =
  'inline-flex h-6 max-w-40 items-center gap-0.5 rounded-md px-1.5 text-xs outline-none transition-[color,background-color,box-shadow] duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring/50';

export interface CrumbClassOptions {
  current: boolean;
  interactive: boolean;
  /** 已折叠到只剩根与当前目录仍放不下：允许各级自行截断 */
  tight: boolean;
  dropOver?: boolean;
}

export function crumbClass({ current, interactive, tight, dropOver }: CrumbClassOptions): string {
  return cn(
    CRUMB_BASE_CLASS,
    tight ? 'min-w-0 shrink' : 'shrink-0',
    current ? 'font-medium text-foreground' : 'text-muted-foreground',
    interactive &&
      'hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground',
    dropOver && 'vibeterm-explorer-drop bg-primary/10 text-foreground ring-1 ring-primary/40'
  );
}

export interface RootSwitcherProps {
  roots: readonly FileRootDto[];
  rootId: string;
  rootName: string;
  className: string;
  testId: string;
  onSelect(rootId: string): void;
}

export function RootSwitcher({
  roots,
  rootId,
  rootName,
  className,
  testId,
  onSelect,
}: RootSwitcherProps) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid={testId}
        data-root-switcher=""
        title={t('explorer.toolbar.root')}
        className={className}
      >
        <span className="truncate">{rootName}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-48 max-w-[80vw]">
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function HiddenCrumbsMenu({
  crumbs,
  onNavigate,
}: {
  crumbs: readonly ExplorerCrumb[];
  onNavigate(path: string): void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="explorer-crumb-overflow"
        aria-label={t('explorer.toolbar.more')}
        className={crumbClass({ current: false, interactive: true, tight: false })}
      >
        <MoreHorizontal className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-40 max-w-[80vw]">
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
