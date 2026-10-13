// 分栏之间的分隔线：指针捕获拖动只更新预览占比，松手才提交（store 每次写入都会落盘）。

import { EXPLORER_MIN_PANE_FRACTION } from '@vibeterm/stores';
import { cn } from '@vibeterm/ui';
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { PANE_KEYBOARD_STEP, equalPaneSizes, resizePanes } from './pane-resize';

export { resizePanes } from './pane-resize';

export interface ExplorerSplitterProps {
  /** 第几条分隔线：位于第 index 与 index + 1 个分栏之间 */
  index: number;
  /** 当前生效的占比（含拖动预览） */
  sizes: readonly number[];
  /** 分栏行的可用宽度（px），拖动开始时读取一次 */
  getTrackWidth(): number;
  /** 拖动中的预览；null = 取消预览 */
  onPreview(sizes: number[] | null): void;
  onCommit(sizes: number[]): void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startSizes: readonly number[];
  width: number;
  latest: number[] | null;
}

type SplitterDragProps = Pick<
  ExplorerSplitterProps,
  'index' | 'sizes' | 'getTrackWidth' | 'onPreview' | 'onCommit'
>;

function useSplitterDrag({ index, sizes, getTrackWidth, onPreview, onCommit }: SplitterDragProps) {
  const drag = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  const endDrag = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (commit && state.latest) onCommit(state.latest);
    onPreview(null);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const width = getTrackWidth();
    if (width <= 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startSizes: sizes,
      width,
      latest: null,
    };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const delta = (event.clientX - state.startX) / state.width;
    state.latest = resizePanes(state.startSizes, index, delta, EXPLORER_MIN_PANE_FRACTION);
    onPreview(state.latest);
  };

  return { dragging, endDrag, onPointerDown, onPointerMove };
}

export function ExplorerSplitter(props: ExplorerSplitterProps) {
  const { index, sizes, onCommit } = props;
  const { dragging, endDrag, onPointerDown, onPointerMove } = useSplitterDrag(props);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' ? -PANE_KEYBOARD_STEP : PANE_KEYBOARD_STEP;
    onCommit(resizePanes(sizes, index, step, EXPLORER_MIN_PANE_FRACTION));
  };

  const leading = sizes.slice(0, index + 1).reduce((total, size) => total + size, 0);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(leading * 100)}
      tabIndex={0}
      data-testid={`explorer-splitter-${index}`}
      data-dragging={dragging || undefined}
      className={cn(
        // 4px 可见线 + 伪元素把命中区扩到 12px
        'relative z-10 w-1 shrink-0 cursor-col-resize touch-none select-none bg-border/60 outline-none',
        'before:absolute before:inset-y-0 before:-inset-x-1 before:content-[""]',
        'transition-colors duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none',
        'hover:bg-primary/50 focus-visible:bg-primary/50 data-[dragging]:bg-primary/50'
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endDrag(event, true)}
      onPointerCancel={(event) => endDrag(event, false)}
      onDoubleClick={() => onCommit(equalPaneSizes(sizes.length))}
      onKeyDown={onKeyDown}
    />
  );
}
