// 两种视图共用的呈现零件：容器 / 条目的状态类名、框选浮层、行 memo 的比较函数等。

import type { FileEntryDto } from '@vibeterm/shared';
import { cn } from '@vibeterm/ui';
import { Checkbox } from '@vibeterm/ui/checkbox';
import { staggerItemStyle } from '@vibeterm/ui/motion';
import type { TFunction } from 'i18next';
import type { CSSProperties } from 'react';
import type { Rect } from './marquee';
import { CHECK_ATTR } from './row-target';
import { EXPLORER_STAGGER_LIMIT } from './use-explorer-view';

/** 视图容器：自身即滚动容器，也是唯一的 Tab 停靠点。 */
export const VIEW_CONTAINER_CLASS =
  'group/view relative h-full min-h-0 flex-1 select-none overflow-auto overscroll-contain outline-none focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring/50';

const ITEM_MOTION_CLASS =
  'transition-[background-color,box-shadow,opacity] duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none';

export const ENTRANCE_CLASS = 'vibeterm-explorer-row-in';

export const EMPTY_VALUE = '—';

/** 行 / 磁贴共用的属性：全是原始值或稳定引用，配合 `itemPropsEqual` 做 memo。 */
export interface ItemProps {
  id: string;
  entry: FileEntryDto;
  /** 入场动画的序号；不播放时为 null */
  stagger: number | null;
  selected: boolean;
  focused: boolean;
  cut: boolean;
  dropTarget: boolean;
  renaming: boolean;
  coarse: boolean;
  skipRender: boolean;
  t: TFunction;
  onToggle(path: string): void;
  onRenameCommit(path: string, name: string): void;
  onRenameCancel(): void;
}

function sameEntry(a: FileEntryDto, b: FileEntryDto): boolean {
  return (
    a === b ||
    (a.path === b.path &&
      a.name === b.name &&
      a.type === b.type &&
      a.category === b.category &&
      a.size === b.size &&
      a.modifiedAt === b.modifiedAt &&
      a.isSymlink === b.isSymlink)
  );
}

/** 轮询刷新会换一批 entry 对象：按字段比较，内容没变的行不重渲染。 */
export function itemPropsEqual<T extends { entry: FileEntryDto }>(a: T, b: T): boolean {
  const keys = Object.keys(a) as Array<keyof T>;
  return keys.every((key) =>
    key === 'entry' ? sameEntry(a.entry, b.entry) : Object.is(a[key], b[key])
  );
}

export function staggerIndex(entering: boolean, index: number): number | null {
  return entering && index < EXPLORER_STAGGER_LIMIT ? index : null;
}

export function itemClass(
  state: Pick<ItemProps, 'selected' | 'cut' | 'dropTarget' | 'stagger'>
): string {
  return cn(
    ITEM_MOTION_CLASS,
    state.selected ? 'bg-primary/12' : 'hover:bg-accent/60',
    state.dropTarget && 'bg-primary/15 ring-1 ring-inset ring-primary/50',
    state.cut && 'opacity-50',
    state.stagger !== null && ENTRANCE_CLASS
  );
}

export function itemStyle(
  stagger: number | null,
  skipRender: boolean,
  skipStyle: CSSProperties
): CSSProperties | undefined {
  if (stagger === null) return skipRender ? skipStyle : undefined;
  const style = staggerItemStyle(stagger);
  return skipRender ? { ...skipStyle, ...style } : style;
}

export function isSymlinkEntry(entry: FileEntryDto): boolean {
  return entry.type === 'symlink' || entry.isSymlink;
}

export function ItemCheckbox({
  entry,
  selected,
  className,
  onToggle,
}: Pick<ItemProps, 'entry' | 'selected' | 'onToggle'> & { className?: string }) {
  const attrs = { [CHECK_ATTR]: '' };
  return (
    <span {...attrs} className={cn('flex shrink-0', className)}>
      <Checkbox
        checked={selected}
        tabIndex={-1}
        aria-label={entry.name}
        data-testid={`explorer-check-${entry.name}`}
        onCheckedChange={() => onToggle(entry.path)}
      />
    </span>
  );
}

export function SymlinkMark({ t, className }: { t: TFunction; className?: string }) {
  return (
    <span
      title={t('files.symlink')}
      className={cn('shrink-0 text-[10px] leading-none text-muted-foreground', className)}
    >
      ↗
    </span>
  );
}

export function MarqueeOverlay({ rect }: { rect: Rect | null }) {
  if (!rect) return null;
  return (
    <div
      aria-hidden
      data-testid="explorer-marquee"
      className="vibeterm-explorer-marquee pointer-events-none absolute z-10 rounded-sm border border-primary/50 bg-primary/10"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
      }}
    />
  );
}

/** 修改时间格式化器；语言标签非法时退回运行环境默认语言。 */
export function createDateFormatter(language: string | undefined): (iso: string | null) => string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat(language?.replace(/_/g, '-'), options);
  } catch {
    format = new Intl.DateTimeFormat(undefined, options);
  }
  return (iso) => {
    if (iso === null) return EMPTY_VALUE;
    const time = Date.parse(iso);
    return Number.isNaN(time) ? EMPTY_VALUE : format.format(time);
  };
}
