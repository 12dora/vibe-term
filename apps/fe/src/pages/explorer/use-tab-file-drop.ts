// 文件拖到标签页标题上：高亮、悬停一会儿切过去（弹簧加载），松手则传到该标签页的当前目录。
// 系统文件只做弹簧加载，不在标题上接收——免得没看清目标目录就传上去了。

import { getActiveDrag, hasExplorerDrag, readDragPayload } from '@vibeterm/panels/explorer';
import type { ExplorerTab } from '@vibeterm/stores';
import { type DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { TAB_SPRING_LOAD_MS, hasOsFileDrag, tabFileDropEffect } from './tab-dnd';
import { useExplorerTransferActions } from './use-explorer-transfer';
import { useWorkspaceActions } from './workspace-actions';

export interface TabFileDrop {
  /** 有文件悬停在这个标签页上 */
  over: boolean;
  onDragOver(event: DragEvent<HTMLElement>): void;
  onDragLeave(event: DragEvent<HTMLElement>): void;
  onDrop(event: DragEvent<HTMLElement>): void;
}

function copyModifier(event: DragEvent<HTMLElement>): boolean {
  return event.altKey || event.ctrlKey;
}

export function useTabFileDrop(tab: ExplorerTab, active: boolean): TabFileDrop {
  const { activateTab } = useWorkspaceActions();
  const { dropOnTab } = useExplorerTransferActions();
  const [over, setOver] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setOver(false);
  }, []);

  useEffect(() => reset, [reset]);

  const armSpringLoad = useCallback(() => {
    if (active || timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      activateTab(tab.id);
    }, TAB_SPRING_LOAD_MS);
  }, [active, activateTab, tab.id]);

  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const internal = hasExplorerDrag(event.dataTransfer);
      if (!internal && !hasOsFileDrag(event.dataTransfer)) return;
      if (internal) {
        event.preventDefault();
        event.dataTransfer.dropEffect = tabFileDropEffect(
          getActiveDrag()?.nodeId,
          tab.nodeId,
          copyModifier(event)
        );
      }
      setOver(true);
      armSpringLoad();
    },
    [armSpringLoad, tab.nodeId]
  );

  const onDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      reset();
    },
    [reset]
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      reset();
      if (!hasExplorerDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const payload = readDragPayload(event.dataTransfer);
      if (payload) dropOnTab(payload, tab, copyModifier(event));
    },
    [dropOnTab, reset, tab]
  );

  return { over, onDragOver, onDragLeave, onDrop };
}
