// 把交互、拖拽、框选三套容器级处理合成一份容器属性，并提供给行用的稳定回调。
// 回调都经 latest ref 转发：上层每次渲染传新函数也不会打穿行的 memo。

import type { FileEntryDto } from '@vibeterm/shared';
import type { TFunction } from 'i18next';
import type { HTMLAttributes, RefObject } from 'react';
import { useEffect, useId, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Rect } from './marquee';
import { useLatestRef } from './use-latest-ref';
import { useMarqueeSelection } from './use-marquee-selection';
import { useRowDrag } from './use-row-drag';
import { type ViewLayout, useViewInteractions } from './use-view-interactions';
import type { ExplorerViewProps } from './view-types';

/** 超过这个条数给行加 content-visibility，视口外的行只占位不绘制 */
export const EXPLORER_SKIP_RENDER_THRESHOLD = 200;
/** 入场动画只给前若干项 */
export const EXPLORER_STAGGER_LIMIT = 24;

export interface ItemCallbacks {
  onToggle(path: string): void;
  onRenameCommit(path: string, name: string): void;
  onRenameCancel(): void;
}

export interface ExplorerViewController {
  containerRef: RefObject<HTMLDivElement | null>;
  containerProps: HTMLAttributes<HTMLDivElement> & { 'data-testid': string };
  marqueeRect: Rect | null;
  /** 本次渲染是否播放入场动画（仅首个带条目的渲染） */
  entering: boolean;
  skipRender: boolean;
  callbacks: ItemCallbacks;
  t: TFunction;
  language: string | undefined;
  focusContainer(): void;
  /** 行的 DOM id（供容器的 aria-activedescendant 指向键盘光标所在行） */
  itemId(index: number): string;
}

export interface ExplorerViewOptions {
  grid: boolean;
  getLayout: () => ViewLayout;
}

function useEntering(count: number): boolean {
  const entered = useRef(false);
  const entering = !entered.current;
  useEffect(() => {
    if (count > 0) entered.current = true;
  }, [count]);
  return entering;
}

function useEntryIndex(entries: readonly FileEntryDto[]) {
  return useMemo(() => {
    const byPath = new Map<string, FileEntryDto>();
    for (const entry of entries) byPath.set(entry.path, entry);
    return { order: entries.map((entry) => entry.path), byPath };
  }, [entries]);
}

/** 行 id 按序号生成；键盘光标所在行的 id 交给容器的 aria-activedescendant。 */
function useItemIds(order: readonly string[], cursor: string | null) {
  const baseId = useId();
  const itemId = useMemo(() => (index: number) => `${baseId}-item-${index}`, [baseId]);
  const cursorIndex = cursor === null ? -1 : order.indexOf(cursor);
  return { itemId, activeId: cursorIndex >= 0 ? itemId(cursorIndex) : undefined };
}

export function useExplorerView(
  props: ExplorerViewProps,
  options: ExplorerViewOptions
): ExplorerViewController {
  const { t, i18n } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const { entries } = props;
  const { order, byPath } = useEntryIndex(entries);

  const marquee = useMarqueeSelection({
    containerRef,
    enabled: !props.coarsePointer,
    order,
    selection: props.selection,
    onSelectionChange: props.onSelectionChange,
  });
  const interactions = useViewInteractions({
    containerRef,
    props,
    order,
    byPath,
    grid: options.grid,
    getLayout: options.getLayout,
    consumeDragClick: marquee.consumeDragClick,
  });
  const drag = useRowDrag({ props, byPath });

  const latest = useLatestRef(props);
  const callbacks = useMemo<ItemCallbacks>(
    () => ({
      onToggle: interactions.onToggle,
      onRenameCommit: (path, name) => latest.current.onRenameCommit(path, name),
      onRenameCancel: () => latest.current.onRenameCancel(),
    }),
    [interactions, latest]
  );

  const { itemId, activeId } = useItemIds(order, props.selection.focus);

  const containerProps = useMemo<ExplorerViewController['containerProps']>(
    () => ({
      role: 'listbox',
      'aria-multiselectable': true,
      'aria-activedescendant': activeId,
      tabIndex: 0,
      'data-testid': 'explorer-view',
      onClick: interactions.onClick,
      onDoubleClick: interactions.onDoubleClick,
      onContextMenu: interactions.onContextMenu,
      onKeyDown: interactions.onKeyDown,
      ...drag,
      ...marquee.handlers,
    }),
    [interactions, drag, marquee.handlers, activeId]
  );

  const focusContainer = useMemo(
    () => () => containerRef.current?.focus({ preventScroll: true }),
    []
  );

  return {
    containerRef,
    containerProps,
    marqueeRect: marquee.rect,
    entering: useEntering(entries.length),
    skipRender: entries.length > EXPLORER_SKIP_RENDER_THRESHOLD,
    callbacks,
    t,
    language: i18n.language,
    focusContainer,
    itemId,
  };
}
