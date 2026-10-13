// 工具条的零件：图标按钮、筛选框、列表/图标切换、「更多」菜单。

import type { ExplorerViewMode } from '@vibeterm/stores';
import { cn } from '@vibeterm/ui';
import { Button } from '@vibeterm/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@vibeterm/ui/dropdown-menu';
import { IconTooltip } from '@vibeterm/ui/icon-tooltip';
import { Input } from '@vibeterm/ui/input';
import { Switch } from '@vibeterm/ui/switch';
import { EyeOff, Keyboard, LayoutGrid, List, MoreHorizontal, Search, X } from 'lucide-react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  EXPLORER_SHORTCUTS,
  type ExplorerCommand,
  formatChord,
  isApplePlatform,
} from '../model/shortcuts';

const MOTION_CLASS = 'duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none';

/** 命令的首个快捷键（用于提示气泡与菜单右侧）；没有绑定时为 null。 */
export function shortcutHint(command: ExplorerCommand, apple: boolean): string | null {
  const chord = EXPLORER_SHORTCUTS.find((item) => item.command === command)?.chords[0];
  return chord ? formatChord(chord, apple) : null;
}

export interface ToolbarIconButtonProps {
  label: string;
  testId: string;
  command?: ExplorerCommand;
  disabled?: boolean;
  busy?: boolean;
  onClick(): void;
  children: ReactNode;
}

export function ToolbarIconButton({
  label,
  testId,
  command,
  disabled,
  busy,
  onClick,
  children,
}: ToolbarIconButtonProps) {
  const hint = command ? shortcutHint(command, isApplePlatform()) : null;
  return (
    <IconTooltip label={hint ? `${label} (${hint})` : label}>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid={testId}
        aria-label={label}
        aria-busy={busy || undefined}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </Button>
    </IconTooltip>
  );
}

export interface ToolbarFilterProps {
  query: string;
  expanded: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onQueryChange(query: string): void;
  onExpandedChange(expanded: boolean): void;
}

function FilterClearButton({ onClear }: { onClear(): void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      data-testid="explorer-filter-clear"
      aria-label={t('explorer.toolbar.clearFilter')}
      className={cn(
        'absolute top-1/2 right-1 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
        MOTION_CLASS
      )}
      // 不抢走输入框焦点
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClear}
    >
      <X className="size-3" />
    </button>
  );
}

/**
 * 筛选框。窄容器下收成一个图标按钮：输入框只是宽度归零而不卸载，
 * 所以快捷键对 `inputRef` 的 focus() 仍然有效，聚焦即展开。
 */
export function ToolbarFilter({
  query,
  expanded,
  inputRef,
  onQueryChange,
  onExpandedChange,
}: ToolbarFilterProps) {
  const { t } = useTranslation();
  const label = t('explorer.toolbar.filter');

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onQueryChange('');
    onExpandedChange(false);
    event.currentTarget.blur();
  };

  return (
    <div className={cn('flex min-w-0 items-center', expanded && 'flex-1 @[30rem]:flex-none')}>
      <IconTooltip label={label} className={cn('@[30rem]:hidden', expanded && 'hidden')}>
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="explorer-filter-toggle"
          aria-label={label}
          onClick={() => {
            onExpandedChange(true);
            inputRef.current?.focus();
          }}
        >
          <Search />
        </Button>
      </IconTooltip>
      <div
        data-expanded={expanded || undefined}
        className={cn(
          'relative shrink-0 transition-[width,opacity] @[30rem]:w-28 @[40rem]:w-40 @[56rem]:w-52',
          MOTION_CLASS,
          expanded
            ? 'w-full'
            : 'w-0 overflow-hidden opacity-0 @[30rem]:overflow-visible @[30rem]:opacity-100'
        )}
      >
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          data-testid="explorer-filter"
          aria-label={label}
          placeholder={label}
          className="h-7 rounded-md pr-7 pl-7 text-xs md:text-xs"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onFocus={() => onExpandedChange(true)}
          onBlur={() => {
            if (query === '') onExpandedChange(false);
          }}
          onKeyDown={handleKeyDown}
        />
        {query !== '' && (
          <FilterClearButton
            onClear={() => {
              onQueryChange('');
              inputRef.current?.focus();
            }}
          />
        )}
      </div>
    </div>
  );
}

function ViewToggleButton({
  label,
  testId,
  pressed,
  onClick,
  children,
}: {
  label: string;
  testId: string;
  pressed: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <IconTooltip label={label}>
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        aria-pressed={pressed}
        className={cn(
          'inline-flex h-[22px] w-6 items-center justify-center rounded-[5px] outline-none transition-[color,background-color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5',
          MOTION_CLASS,
          pressed
            ? 'bg-background text-foreground shadow-xs ring-1 ring-foreground/10'
            : 'text-muted-foreground hover:text-foreground'
        )}
        onClick={onClick}
      >
        {children}
      </button>
    </IconTooltip>
  );
}

export function ViewToggle({
  viewMode,
  onViewModeChange,
}: {
  viewMode: ExplorerViewMode;
  onViewModeChange(mode: ExplorerViewMode): void;
}) {
  const { t } = useTranslation();
  return (
    // biome-ignore lint/a11y/useSemanticElements: 分段按钮组，<fieldset> 自带的边框与表单语义不适用
    <div
      role="group"
      data-testid="explorer-view-toggle"
      className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-lg bg-muted p-[3px]"
    >
      <ViewToggleButton
        label={t('explorer.toolbar.viewList')}
        testId="explorer-view-list"
        pressed={viewMode === 'list'}
        onClick={() => onViewModeChange('list')}
      >
        <List />
      </ViewToggleButton>
      <ViewToggleButton
        label={t('explorer.toolbar.viewGrid')}
        testId="explorer-view-grid"
        pressed={viewMode === 'grid'}
        onClick={() => onViewModeChange('grid')}
      >
        <LayoutGrid />
      </ViewToggleButton>
    </div>
  );
}

export function MoreMenu({
  showHidden,
  onShowHiddenChange,
  onShowShortcuts,
}: {
  showHidden: boolean;
  onShowHiddenChange(show: boolean): void;
  onShowShortcuts(): void;
}) {
  const { t } = useTranslation();
  const shortcutsHint = shortcutHint('showShortcuts', isApplePlatform());
  return (
    <DropdownMenu>
      <IconTooltip label={t('explorer.toolbar.more')}>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" />}
          data-testid="explorer-more"
          aria-label={t('explorer.toolbar.more')}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
      </IconTooltip>
      <DropdownMenuContent align="end" className="w-auto min-w-56">
        <DropdownMenuItem
          closeOnClick={false}
          data-testid="explorer-show-hidden"
          data-checked={showHidden || undefined}
          onClick={() => onShowHiddenChange(!showHidden)}
        >
          <EyeOff />
          <span className="min-w-0 flex-1 truncate">{t('explorer.toolbar.showHidden')}</span>
          <Switch
            size="sm"
            checked={showHidden}
            tabIndex={-1}
            aria-label={t('explorer.toolbar.showHidden')}
            className="pointer-events-none"
          />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="explorer-show-shortcuts" onClick={onShowShortcuts}>
          <Keyboard />
          <span className="min-w-0 flex-1 truncate">{t('explorer.toolbar.shortcuts')}</span>
          {shortcutsHint && <DropdownMenuShortcut>{shortcutsHint}</DropdownMenuShortcut>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
