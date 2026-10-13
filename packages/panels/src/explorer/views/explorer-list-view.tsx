// 详情列表视图：粘性表头 + 30px 行。只有「图标 + 名称」是拖拽源，
// 行内其余空白处按下拖动是框选（与桌面文件管理器的详情视图一致）。

import { formatBytes } from '@vibeterm/api-client';
import type { ExplorerSortKey } from '@vibeterm/stores';
import { cn } from '@vibeterm/ui';
import { Folder } from 'lucide-react';
import type { CSSProperties } from 'react';
import { memo, useCallback, useMemo } from 'react';
import { fileIconColor, fileIconFor } from '../../files/file-icon';
import { entryKindKey, isDirectoryEntry } from '../model/entries';
import { InlineNameEditor } from './inline-name-editor';
import {
  KIND_CELL_CLASS,
  ListHeader,
  MODIFIED_CELL_CLASS,
  NAME_CELL_CLASS,
  SIZE_CELL_CLASS,
  nextSort,
} from './list-header';
import { INERT_ATTR, ROW_DIR_ATTR, ROW_PATH_ATTR } from './row-target';
import { useExplorerView } from './use-explorer-view';
import { useLatestRef } from './use-latest-ref';
import type { ViewLayout } from './use-view-interactions';
import {
  EMPTY_VALUE,
  ENTRANCE_CLASS,
  ItemCheckbox,
  type ItemProps,
  MarqueeOverlay,
  SymlinkMark,
  VIEW_CONTAINER_CLASS,
  createDateFormatter,
  isSymlinkEntry,
  itemClass,
  itemPropsEqual,
  itemStyle,
  staggerIndex,
} from './view-parts';
import type { ExplorerViewProps } from './view-types';

export const LIST_ROW_HEIGHT = 30;

// 行间有 1px 间隙，翻页按行距折算
const LIST_LAYOUT: ViewLayout = { columns: 1, rowHeight: LIST_ROW_HEIGHT + 1 };
const getListLayout = (): ViewLayout => LIST_LAYOUT;

const SKIPPED_ROW_STYLE: CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: `auto ${LIST_ROW_HEIGHT}px`,
};

// scroll-mt 让键盘滚动（scrollIntoView）停在粘性表头下方而不是被它盖住
const ROW_CLASS =
  'mx-1 flex h-[30px] scroll-mt-7 items-center gap-2 rounded-md px-2 text-[13px] outline-none group-focus-within/view:data-focused:shadow-[inset_2px_0_0_var(--primary)]';
const META_CLASS = 'truncate text-xs tabular-nums text-muted-foreground';

interface ListRowProps extends ItemProps {
  formatDate(iso: string | null): string;
}

function RowName({ entry, renaming, coarse, t, onRenameCommit, onRenameCancel }: ListRowProps) {
  const Icon = fileIconFor(entry);
  const dir = isDirectoryEntry(entry);
  return (
    <div className={NAME_CELL_CLASS}>
      <div
        draggable={!coarse && !renaming}
        className={cn('flex min-w-0 items-center gap-2', renaming && 'flex-1')}
      >
        <Icon aria-hidden className={cn('size-4 shrink-0', fileIconColor(entry.category))} />
        {renaming ? (
          <InlineNameEditor
            initialName={entry.name}
            selectStem={!dir}
            className="flex-1 text-[13px]"
            onCommit={(name) => onRenameCommit(entry.path, name)}
            onCancel={onRenameCancel}
          />
        ) : (
          <span className="truncate" title={entry.name}>
            {entry.name}
          </span>
        )}
        {isSymlinkEntry(entry) && <SymlinkMark t={t} />}
      </div>
    </div>
  );
}

const ListRow = memo(function ListRow(props: ListRowProps) {
  const { entry, selected, focused, t } = props;
  const dir = isDirectoryEntry(entry);
  const attrs = { [ROW_PATH_ATTR]: entry.path, [ROW_DIR_ATTR]: dir ? '' : undefined };
  return (
    <div
      {...attrs}
      id={props.id}
      // biome-ignore lint/a11y/useSemanticElements: 多选列表项要自绘多列与行内编辑，原生 <option> 承载不了
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      data-focused={focused ? '' : undefined}
      data-testid={`explorer-item-${entry.name}`}
      style={itemStyle(props.stagger, props.skipRender, SKIPPED_ROW_STYLE)}
      className={cn(ROW_CLASS, itemClass(props))}
    >
      {props.coarse && <ItemCheckbox entry={entry} selected={selected} onToggle={props.onToggle} />}
      <RowName {...props} />
      <span className={cn(SIZE_CELL_CLASS, META_CLASS)}>
        {dir || entry.size === null ? EMPTY_VALUE : formatBytes(entry.size)}
      </span>
      <span className={cn(KIND_CELL_CLASS, META_CLASS)}>{t(entryKindKey(entry))}</span>
      <span className={cn(MODIFIED_CELL_CLASS, META_CLASS)}>
        {props.formatDate(entry.modifiedAt)}
      </span>
    </div>
  );
}, itemPropsEqual);

interface PendingRowProps {
  name: string;
  coarse: boolean;
  onCommit(name: string): void;
  onCancel(): void;
}

function PendingRow({ name, coarse, onCommit, onCancel }: PendingRowProps) {
  const attrs = { [INERT_ATTR]: '' };
  return (
    <div
      {...attrs}
      role="presentation"
      data-testid="explorer-pending-folder"
      className={cn(ROW_CLASS, ENTRANCE_CLASS, 'bg-primary/12')}
    >
      {coarse && <span aria-hidden className="w-4 shrink-0" />}
      <Folder aria-hidden className={cn('size-4 shrink-0', fileIconColor('directory'))} />
      <InlineNameEditor
        initialName={name}
        commitUnchanged
        className="flex-1 text-[13px]"
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
}

export function ExplorerListView(props: ExplorerViewProps) {
  const view = useExplorerView(props, { grid: false, getLayout: getListLayout });
  const { entries, selection, pendingFolder, coarsePointer } = props;
  const { t, callbacks, focusContainer } = view;
  const formatDate = useMemo(() => createDateFormatter(view.language), [view.language]);
  const latest = useLatestRef(props);
  const onSort = useCallback(
    (key: ExplorerSortKey) => {
      latest.current.onSortChange(nextSort(latest.current.sort, key));
      focusContainer();
    },
    [latest, focusContainer]
  );

  return (
    <div
      ref={view.containerRef}
      {...view.containerProps}
      className={cn(VIEW_CONTAINER_CLASS, '@container')}
    >
      <ListHeader sort={props.sort} coarse={coarsePointer} t={t} onSort={onSort} />
      <div role="presentation" className="flex flex-col gap-px pt-1 pb-6">
        {pendingFolder && (
          <PendingRow
            name={pendingFolder.name}
            coarse={coarsePointer}
            onCommit={props.onPendingFolderCommit}
            onCancel={props.onPendingFolderCancel}
          />
        )}
        {entries.map((entry, index) => (
          <ListRow
            key={entry.path}
            id={view.itemId(index)}
            entry={entry}
            stagger={staggerIndex(view.entering, index)}
            selected={selection.selected.has(entry.path)}
            focused={selection.focus === entry.path}
            cut={props.cutPaths.has(entry.path)}
            dropTarget={props.dropTargetPath === entry.path}
            renaming={props.renamingPath === entry.path}
            coarse={coarsePointer}
            skipRender={view.skipRender}
            t={t}
            formatDate={formatDate}
            onToggle={callbacks.onToggle}
            onRenameCommit={callbacks.onRenameCommit}
            onRenameCancel={callbacks.onRenameCancel}
          />
        ))}
      </div>
      <MarqueeOverlay rect={view.marqueeRect} />
    </div>
  );
}
