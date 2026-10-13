// `DeviceFolderTree` 的拖拽状态：谁在被拖、指针 / 键盘、落点解析、预览（占位条 / 同容器重排），
// 以及松手之后到布局落定之间的那一小段「定格」。
//
// 定格：`onDrop` 把新布局交给宿主，宿主的乐观更新要晚一两帧才回到 `layout` 上。这期间如果
// 立刻撤掉预览，条目会先弹回旧位置、再跳到新位置。所以松手后预览原样保留，直到 `layout`
// 换了引用（新布局到了）；宿主没接这次提交（上一次还在飞）时由超时兜底撤掉，条目滑回原位。

import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';
import type { DeviceFolderLayout } from '@vibeterm/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type DeviceFolderContainer,
  type DeviceFolderDrop,
  type DeviceFolderPlaceholder,
  type DeviceFolderReorderPreview,
  ROOT_CONTAINER_ID,
  containerFolderId,
  dropTargetContainerId,
  dropZoneId,
  previewPlaceholder,
  previewReorder,
  resolveDrop,
} from './folder-tree-model';

/** 拖过折叠分组多久自动展开 */
const AUTO_EXPAND_MS = 600;

/** 松手后最多等多久布局落定；超时说明这次提交没被接受，撤掉预览 */
const SETTLE_TIMEOUT_MS = 600;

export type TreeDragMode = 'pointer' | 'keyboard';

export function dragModeOf(activatorEvent: Event | null | undefined): TreeDragMode {
  const keyboard = typeof KeyboardEvent !== 'undefined' && activatorEvent instanceof KeyboardEvent;
  return keyboard ? 'keyboard' : 'pointer';
}

export interface TreeDragInput {
  layout: DeviceFolderLayout;
  implicitRootNodeIds: readonly string[];
  containers: Map<string, DeviceFolderContainer>;
  expanded: Record<string, boolean>;
  onExpandedChange: (folderId: string, expanded: boolean) => void;
  onDrop: (drop: DeviceFolderDrop) => void;
  disabled: boolean;
}

export interface TreeDrag {
  activeId: string | null;
  /** 当前拖拽命中的容器（高亮用）；没在拖 / 无效落点为 null */
  dropContainerId: string | null;
  /** 指针停在所有分组之外的空白：整棵树高亮，示意松手会移到最外层 */
  rootDropActive: boolean;
  placeholder: DeviceFolderPlaceholder | null;
  reorder: DeviceFolderReorderPreview | null;
  /** 预览靠真实回流（指针拖拽）；键盘拖拽为 false */
  reflow: boolean;
  /** 拖拽中或定格中 */
  tracking: boolean;
  /** 预览 / 展开态一变就变的签名：落点矩形该重新量了。没在拖为空串 */
  reflowSignal: string;
  onDragStart: (event: DragStartEvent) => void;
  onDragOver: (event: DragOverEvent) => void;
  onDragCancel: () => void;
  onDragEnd: (event: DragEndEvent) => void;
}

interface Settle {
  drop: DeviceFolderDrop;
  layout: DeviceFolderLayout;
  mode: TreeDragMode;
}

/** 拖过折叠的分组停留一会儿就自动展开，方便往里放 */
function useAutoExpand(
  activeId: string | null,
  dropContainerId: string | null,
  expanded: Record<string, boolean>,
  onExpandedChange: (folderId: string, expanded: boolean) => void
): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!activeId || !dropContainerId) return;
    const folderId = containerFolderId(dropContainerId);
    if (!folderId || expanded[folderId] !== false) return;
    timerRef.current = setTimeout(() => onExpandedChange(folderId, true), AUTO_EXPAND_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [activeId, dropContainerId, expanded, onExpandedChange]);
}

/** 定格只对「提交时的那份 layout」有效；layout 换了引用或超时就失效 */
function useSettle(layout: DeviceFolderLayout) {
  const [settle, setSettle] = useState<Settle | null>(null);
  useEffect(() => {
    if (!settle) return;
    if (settle.layout !== layout) {
      setSettle(null);
      return;
    }
    const timer = setTimeout(() => setSettle(null), SETTLE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [settle, layout]);
  return [settle && settle.layout === layout ? settle : null, setSettle] as const;
}

/** 目标分组还收着的时候不插占位条：内容区没挂载，插了也看不见（等自动展开之后再说） */
function visiblePlaceholder(
  placeholder: DeviceFolderPlaceholder | null,
  expanded: Record<string, boolean>
): DeviceFolderPlaceholder | null {
  if (!placeholder) return null;
  const folderId = containerFolderId(placeholder.containerId);
  return folderId && expanded[folderId] === false ? null : placeholder;
}

export function useTreeDrag(input: TreeDragInput): TreeDrag {
  const { layout, implicitRootNodeIds, containers, expanded, onExpandedChange, onDrop } = input;
  const { disabled } = input;
  const [drag, setDrag] = useState<{ activeId: string; mode: TreeDragMode } | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [settle, setSettle] = useSettle(layout);
  const activeId = drag?.activeId ?? null;

  const activeDrop = useMemo(
    () =>
      activeId && overId
        ? resolveDrop(activeId, overId, layout, implicitRootNodeIds, containers)
        : null,
    [activeId, overId, layout, implicitRootNodeIds, containers]
  );
  const previewDrop = activeDrop ?? settle?.drop ?? null;
  const reflow = (drag ?? settle)?.mode !== 'keyboard';
  const placeholder = useMemo(
    () =>
      visiblePlaceholder(
        previewPlaceholder(layout, implicitRootNodeIds, previewDrop, containers),
        expanded
      ),
    [layout, implicitRootNodeIds, previewDrop, containers, expanded]
  );
  const reorder = useMemo(
    () => (reflow ? previewReorder(previewDrop, containers) : null),
    [reflow, previewDrop, containers]
  );
  const dropContainerId = dropTargetContainerId(activeDrop);
  useAutoExpand(activeId, dropContainerId, expanded, onExpandedChange);

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      setSettle(null);
      setDrag({ activeId: String(event.active.id), mode: dragModeOf(event.activatorEvent) });
    },
    [setSettle]
  );
  const onDragOver = useCallback(
    (event: DragOverEvent) => setOverId(event.over ? String(event.over.id) : null),
    []
  );
  const onDragCancel = useCallback(() => {
    setDrag(null);
    setOverId(null);
  }, []);
  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const dropId = event.over ? String(event.over.id) : null;
      setDrag(null);
      setOverId(null);
      // 指针离开整棵树（含拖出窗口）：取消，不动布局
      if (disabled || dropId === null) return;
      const dragId = String(event.active.id);
      const drop = resolveDrop(dragId, dropId, layout, implicitRootNodeIds, containers);
      if (!drop) return;
      setSettle({ drop, layout, mode: dragModeOf(event.activatorEvent) });
      onDrop(drop);
    },
    [disabled, layout, implicitRootNodeIds, containers, onDrop, setSettle]
  );

  return {
    activeId,
    dropContainerId,
    rootDropActive:
      activeId !== null && overId === dropZoneId(ROOT_CONTAINER_ID) && activeDrop !== null,
    placeholder,
    reorder,
    reflow,
    tracking: drag !== null || settle !== null,
    reflowSignal: activeId ? JSON.stringify([activeId, placeholder, reorder, expanded]) : '',
    onDragStart,
    onDragOver,
    onDragCancel,
    onDragEnd,
  };
}
