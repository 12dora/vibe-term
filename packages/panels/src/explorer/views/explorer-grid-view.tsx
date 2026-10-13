// 图标视图：自适应列数的磁贴网格。列数由 ResizeObserver 量出，供方向键上下移动时换算步长。

import { cn } from '@vibeterm/ui';
import { Folder } from 'lucide-react';
import type { CSSProperties, RefObject } from 'react';
import { memo, useCallback, useEffect, useRef } from 'react';
import { fileIconColor, fileIconFor } from '../../files/file-icon';
import { isDirectoryEntry } from '../model/entries';
import { InlineNameEditor } from './inline-name-editor';
import { columnsFromTemplate, gridColumnCount } from './keyboard-intent';
import { INERT_ATTR, ROW_DIR_ATTR, ROW_PATH_ATTR, ROW_SELECTOR } from './row-target';
import { useExplorerView } from './use-explorer-view';
import type { ViewLayout } from './use-view-interactions';
import {
  ENTRANCE_CLASS,
  ItemCheckbox,
  type ItemProps,
  MarqueeOverlay,
  SymlinkMark,
  VIEW_CONTAINER_CLASS,
  isSymlinkEntry,
  itemClass,
  itemPropsEqual,
  itemStyle,
  staggerIndex,
} from './view-parts';
import type { ExplorerViewProps } from './view-types';

export const GRID_TILE_HEIGHT = 96;

const SKIPPED_TILE_STYLE: CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: `auto ${GRID_TILE_HEIGHT}px`,
};

const GRID_CLASS = 'grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-1 p-2 pb-6';
const TILE_CLASS =
  'relative flex min-h-24 min-w-0 scroll-m-2 flex-col items-center gap-1.5 rounded-lg px-1.5 py-2.5 outline-none group-focus-within/view:data-focused:ring-1 group-focus-within/view:data-focused:ring-inset group-focus-within/view:data-focused:ring-primary/60';
const TILE_NAME_CLASS =
  'line-clamp-2 w-full text-center text-[11px] leading-[14px] [overflow-wrap:anywhere]';
const TILE_EDITOR_CLASS = 'w-full px-1 text-center text-[11px]';
const TILE_ICON_CLASS = 'size-10 shrink-0';

const FALLBACK_LAYOUT: ViewLayout = { columns: 1, rowHeight: GRID_TILE_HEIGHT + 4 };

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function measureGrid(grid: HTMLElement): ViewLayout {
  const tile = grid.querySelector<HTMLElement>(ROW_SELECTOR);
  if (!tile) return FALLBACK_LAYOUT;
  const style = getComputedStyle(grid);
  const box = tile.getBoundingClientRect();
  return {
    // 以浏览器实际排出的轨道数为准；量宽度估算在亚像素列宽下会少算一列
    columns: columnsFromTemplate(style.gridTemplateColumns) ?? estimateColumns(grid, style, box),
    rowHeight: box.height + pixels(style.rowGap),
  };
}

function estimateColumns(grid: HTMLElement, style: CSSStyleDeclaration, tile: DOMRect): number {
  const inner = grid.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight);
  return gridColumnCount(inner, tile.width, pixels(style.columnGap));
}

/** 网格尺寸或「有没有磁贴」变化时重量一次，结果放进 ref，按键时直接读。 */
function useGridLayout(
  gridRef: RefObject<HTMLElement | null>,
  hasTiles: boolean
): () => ViewLayout {
  const layout = useRef<ViewLayout>(FALLBACK_LAYOUT);
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasTiles 变化时首个磁贴出现 / 消失，需要重量
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = (): void => {
      layout.current = measureGrid(grid);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [gridRef, hasTiles]);
  return useCallback(() => layout.current, []);
}

const GridTile = memo(function GridTile(props: ItemProps) {
  const { entry, selected, focused, renaming, coarse, t } = props;
  const dir = isDirectoryEntry(entry);
  const Icon = fileIconFor(entry);
  const attrs = { [ROW_PATH_ATTR]: entry.path, [ROW_DIR_ATTR]: dir ? '' : undefined };
  return (
    <div
      {...attrs}
      id={props.id}
      // biome-ignore lint/a11y/useSemanticElements: 多选列表项要自绘图标与行内编辑，原生 <option> 承载不了
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      draggable={!coarse && !renaming}
      data-focused={focused ? '' : undefined}
      data-testid={`explorer-item-${entry.name}`}
      style={itemStyle(props.stagger, props.skipRender, SKIPPED_TILE_STYLE)}
      className={cn(TILE_CLASS, itemClass(props))}
    >
      {coarse && (
        <ItemCheckbox
          entry={entry}
          selected={selected}
          className="absolute top-1.5 left-1.5"
          onToggle={props.onToggle}
        />
      )}
      <span className="relative flex">
        <Icon
          aria-hidden
          strokeWidth={1.25}
          className={cn(TILE_ICON_CLASS, fileIconColor(entry.category))}
        />
        {isSymlinkEntry(entry) && (
          <SymlinkMark t={t} className="absolute -right-2 -bottom-0.5 text-[11px]" />
        )}
      </span>
      {renaming ? (
        <InlineNameEditor
          initialName={entry.name}
          selectStem={!dir}
          className={TILE_EDITOR_CLASS}
          onCommit={(name) => props.onRenameCommit(entry.path, name)}
          onCancel={props.onRenameCancel}
        />
      ) : (
        <span className={TILE_NAME_CLASS} title={entry.name}>
          {entry.name}
        </span>
      )}
    </div>
  );
}, itemPropsEqual);

interface PendingTileProps {
  name: string;
  onCommit(name: string): void;
  onCancel(): void;
}

function PendingTile({ name, onCommit, onCancel }: PendingTileProps) {
  const attrs = { [INERT_ATTR]: '' };
  return (
    <div
      {...attrs}
      role="presentation"
      data-testid="explorer-pending-folder"
      className={cn(TILE_CLASS, ENTRANCE_CLASS, 'bg-primary/12')}
    >
      <Folder
        aria-hidden
        strokeWidth={1.25}
        className={cn(TILE_ICON_CLASS, fileIconColor('directory'))}
      />
      <InlineNameEditor
        initialName={name}
        commitUnchanged
        className={TILE_EDITOR_CLASS}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
}

export function ExplorerGridView(props: ExplorerViewProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const { entries, selection, pendingFolder } = props;
  const getLayout = useGridLayout(gridRef, entries.length > 0);
  const view = useExplorerView(props, { grid: true, getLayout });
  const { t, callbacks } = view;

  return (
    <div ref={view.containerRef} {...view.containerProps} className={VIEW_CONTAINER_CLASS}>
      <div ref={gridRef} role="presentation" className={GRID_CLASS}>
        {pendingFolder && (
          <PendingTile
            name={pendingFolder.name}
            onCommit={props.onPendingFolderCommit}
            onCancel={props.onPendingFolderCancel}
          />
        )}
        {entries.map((entry, index) => (
          <GridTile
            key={entry.path}
            id={view.itemId(index)}
            entry={entry}
            stagger={staggerIndex(view.entering, index)}
            selected={selection.selected.has(entry.path)}
            focused={selection.focus === entry.path}
            cut={props.cutPaths.has(entry.path)}
            dropTarget={props.dropTargetPath === entry.path}
            renaming={props.renamingPath === entry.path}
            coarse={props.coarsePointer}
            skipRender={view.skipRender}
            t={t}
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
