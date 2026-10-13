// 详情列表的表头：点击列名切换排序，再点当前列翻转方向。列宽类名与行共用。

import type { ExplorerSort, ExplorerSortKey } from '@vibeterm/stores';
import { cn } from '@vibeterm/ui';
import type { TFunction } from 'i18next';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { memo } from 'react';
import { INERT_ATTR } from './row-target';

export const NAME_CELL_CLASS = 'flex min-w-0 flex-1';
export const SIZE_CELL_CLASS = 'w-[88px] shrink-0 text-right';
/** 容器窄于 34rem 时收起「类型」，窄于 44rem 时收起「修改时间」 */
export const KIND_CELL_CLASS = 'hidden w-[112px] shrink-0 @[34rem]:block';
export const MODIFIED_CELL_CLASS = 'hidden w-[168px] shrink-0 @[44rem]:block';

/** 大小、修改时间首次点击按降序（先看最大 / 最新），其余按升序。 */
const DEFAULT_DIRECTION: Record<ExplorerSortKey, ExplorerSort['dir']> = {
  name: 'asc',
  kind: 'asc',
  size: 'desc',
  modifiedAt: 'desc',
};

export function nextSort(current: ExplorerSort, key: ExplorerSortKey): ExplorerSort {
  if (current.key !== key) return { key, dir: DEFAULT_DIRECTION[key] };
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

interface Column {
  key: ExplorerSortKey;
  labelKey: string;
  cellClass: string;
  alignEnd?: boolean;
}

const COLUMNS: readonly Column[] = [
  { key: 'name', labelKey: 'explorer.column.name', cellClass: NAME_CELL_CLASS },
  { key: 'size', labelKey: 'explorer.column.size', cellClass: SIZE_CELL_CLASS, alignEnd: true },
  { key: 'kind', labelKey: 'explorer.column.kind', cellClass: KIND_CELL_CLASS },
  { key: 'modifiedAt', labelKey: 'explorer.column.modified', cellClass: MODIFIED_CELL_CLASS },
];

function ariaSort(sort: ExplorerSort, key: ExplorerSortKey): 'ascending' | 'descending' | 'none' {
  if (sort.key !== key) return 'none';
  return sort.dir === 'asc' ? 'ascending' : 'descending';
}

interface HeaderCellProps {
  column: Column;
  sort: ExplorerSort;
  t: TFunction;
  onSort(key: ExplorerSortKey): void;
}

function HeaderCell({ column, sort, t, onSort }: HeaderCellProps) {
  const active = sort.key === column.key;
  const Chevron = sort.dir === 'asc' ? ChevronUp : ChevronDown;
  return (
    // biome-ignore lint/a11y/useSemanticElements: 列表用 div 布局以支持容器查询折叠列，无法换成 <th>
    <div role="columnheader" aria-sort={ariaSort(sort, column.key)} className={column.cellClass}>
      <button
        type="button"
        tabIndex={-1}
        data-testid={`explorer-sort-${column.key}`}
        className={cn(
          'flex h-7 w-full min-w-0 items-center gap-1 outline-none transition-colors duration-(--vibeterm-motion-fast) ease-out hover:text-foreground motion-reduce:transition-none',
          column.alignEnd && 'flex-row-reverse',
          active && 'text-foreground'
        )}
        onClick={() => onSort(column.key)}
      >
        <span className="truncate">{t(column.labelKey)}</span>
        <Chevron
          aria-hidden
          className={cn(
            'size-3 shrink-0 transition-opacity duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none',
            active ? 'opacity-100' : 'opacity-0'
          )}
        />
      </button>
    </div>
  );
}

export interface ListHeaderProps {
  sort: ExplorerSort;
  coarse: boolean;
  t: TFunction;
  onSort(key: ExplorerSortKey): void;
}

export const ListHeader = memo(function ListHeader({ sort, coarse, t, onSort }: ListHeaderProps) {
  const attrs = { [INERT_ATTR]: '' };
  return (
    <div
      {...attrs}
      role="presentation"
      data-testid="explorer-list-header"
      className="sticky top-0 z-20 flex h-7 items-center gap-2 border-b border-border bg-background/90 px-3 text-[11px] font-medium text-muted-foreground backdrop-blur-sm"
      // 点表头不抢焦点：焦点留在视图容器上，方向键才能接着用
      onMouseDown={(event) => event.preventDefault()}
    >
      {coarse && <span aria-hidden className="w-4 shrink-0" />}
      {COLUMNS.map((column) => (
        <HeaderCell key={column.key} column={column} sort={sort} t={t} onSort={onSort} />
      ))}
    </div>
  );
});
