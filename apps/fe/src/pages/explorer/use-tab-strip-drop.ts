// 标签页拖放到标签栏：按指针位置算插入位、显示插入线，松手后重排或跨分栏移动。

import { type DragEvent, type RefObject, useCallback, useState } from 'react';
import {
  EXPLORER_TAB_MIME,
  adjustIndexForSamePane,
  getDraggedTabId,
  hasTabDrag,
  insertionIndex,
  measureTabStrip,
} from './tab-dnd';
import { useWorkspaceStore } from './workspace-actions';

interface DropSlot {
  index: number;
  /** 插入线在标签行内的 X 偏移 */
  x: number;
}

export interface TabStripDrop {
  /** 插入线位置；null = 没有标签页悬停在本栏上 */
  lineX: number | null;
  onDragOver(event: DragEvent<HTMLElement>): void;
  onDragLeave(event: DragEvent<HTMLElement>): void;
  onDrop(event: DragEvent<HTMLElement>): void;
}

function slotAt(row: HTMLElement | null, clientX: number): DropSlot | null {
  if (!row) return null;
  const metrics = measureTabStrip(row);
  const index = insertionIndex(metrics.midpoints, clientX);
  return { index, x: metrics.edges[index] ?? 0 };
}

/** `enabled` 为 false 时整条标签栏不接收标签页（窄屏合并栏：下标对不上任何一个分栏） */
export function useTabStripDrop(
  paneId: string,
  rowRef: RefObject<HTMLElement | null>,
  enabled = true
): TabStripDrop {
  const store = useWorkspaceStore();
  const [slot, setSlot] = useState<DropSlot | null>(null);

  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || !hasTabDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const next = slotAt(rowRef.current, event.clientX);
      setSlot((prev) => (prev?.index === next?.index && prev?.x === next?.x ? prev : next));
    },
    [rowRef, enabled]
  );

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setSlot(null);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || !hasTabDrag(event.dataTransfer)) return;
      event.preventDefault();
      setSlot(null);
      const tabId = event.dataTransfer.getData(EXPLORER_TAB_MIME) || getDraggedTabId();
      const target = slotAt(rowRef.current, event.clientX);
      if (!tabId || !target) return;
      const state = store.getState();
      const pane = state.panes.find((item) => item.id === paneId);
      if (!pane) return;
      // store 的下标是「先移除再插入」的位置；同栏重排要扣掉自己原来占的那一位
      const from = pane.tabIds.indexOf(tabId);
      state.moveTab(tabId, paneId, adjustIndexForSamePane(from, target.index));
    },
    [paneId, rowRef, store, enabled]
  );

  return { lineX: slot?.x ?? null, onDragOver, onDragLeave, onDrop };
}
