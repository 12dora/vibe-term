// 行的拖拽源 + 放置目标接线，全部委托在容器上。视图不判断能不能放：
// 上层在 onDragOverTarget 里自己 preventDefault，并通过 dropTargetPath 把高亮喂回来。

import type { FileEntryDto } from '@vibeterm/shared';
import type { DragEvent } from 'react';
import { useMemo, useRef } from 'react';
import { selectOnly } from '../model/selection';
import { dropPathOf, rowPathOf } from './row-target';
import { useLatestRef } from './use-latest-ref';
import type { ExplorerViewProps } from './view-types';

export interface RowDragOptions {
  props: ExplorerViewProps;
  byPath: ReadonlyMap<string, FileEntryDto>;
}

export interface RowDragHandlers {
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: (event: DragEvent<HTMLElement>) => void;
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

const DRAG_PILL_CLASS =
  'pointer-events-none fixed left-[-1000px] top-[-1000px] z-50 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-2 text-xs font-medium tabular-nums text-primary-foreground shadow-md';

/** 多选拖拽时的拖影：一个带数量的小药丸，放在屏幕外供浏览器截图，下一帧移除。 */
function setCountDragImage(dataTransfer: DataTransfer, count: number): void {
  if (typeof document === 'undefined' || typeof dataTransfer.setDragImage !== 'function') return;
  const pill = document.createElement('div');
  pill.className = DRAG_PILL_CLASS;
  pill.textContent = String(count);
  document.body.appendChild(pill);
  dataTransfer.setDragImage(pill, 12, 12);
  requestAnimationFrame(() => pill.remove());
}

function handleDragStart(options: RowDragOptions, event: DragEvent<HTMLElement>): void {
  const { props, byPath } = options;
  const path = rowPathOf(event.target);
  const entry = path === null ? undefined : byPath.get(path);
  if (!entry) return;
  if (props.coarsePointer) {
    event.preventDefault();
    return;
  }
  let count = props.selection.selected.size;
  if (!props.selection.selected.has(entry.path)) {
    props.onSelectionChange(selectOnly(entry.path));
    count = 1;
  }
  if (count > 1) setCountDragImage(event.dataTransfer, count);
  props.onItemDragStart(entry, event);
}

export function useRowDrag(options: RowDragOptions): RowDragHandlers {
  const latest = useLatestRef(options);
  // dragenter / dragleave 会在子元素之间成对冒泡，用深度计数判断指针是否真的离开了视图
  const depth = useRef(0);

  return useMemo<RowDragHandlers>(
    () => ({
      onDragStart: (event) => handleDragStart(latest.current, event),
      onDragEnd: (event) => {
        depth.current = 0;
        latest.current.props.onItemDragEnd(event);
      },
      onDragEnter: () => {
        depth.current += 1;
      },
      onDragOver: (event) => {
        latest.current.props.onDragOverTarget(dropPathOf(event.target), event);
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) latest.current.props.onDragLeaveAll();
      },
      onDrop: (event) => {
        depth.current = 0;
        latest.current.props.onDropTarget(dropPathOf(event.target), event);
      },
    }),
    [latest]
  );
}
