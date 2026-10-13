// 焦点管理：标签页成为键盘属主时聚焦视图；导航、换视图后把焦点带回视图；
// 焦点行被移除（删除、轮询刷新）或输入框失焦后落到 body 时拿回来。视图一直握着焦点，快捷键才连贯。

import type { FocusEvent, RefObject } from 'react';
import { useCallback, useEffect } from 'react';
import {
  findViewRow,
  focusView,
  isFocusInside,
  isFocusLost,
  shouldRefocusAfterNavigation,
} from './browser-dom';
import { useLatest } from './use-keyed-state';

const FLASH_CLASS = 'vibeterm-explorer-flash';

export interface BrowserFocusOptions {
  rootRef: RefObject<HTMLElement | null>;
  active: boolean;
  /** 我们自己的对话框 / 菜单开着：焦点归它们 */
  suspended: boolean;
  /** 位置 + 视图模式 + 内容形态；变了就说明视图容器换了一个 */
  contentKey: string;
  /** 条目变化（可能带走了持有焦点的行） */
  entries: unknown;
}

export function useBrowserFocus(options: BrowserFocusOptions) {
  const { rootRef, active, contentKey, entries } = options;
  const latest = useLatest(options);

  useEffect(() => {
    if (active && !isFocusInside(rootRef.current)) focusView(rootRef.current);
  }, [active, rootRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: contentKey 只作触发条件
  useEffect(() => {
    if (!latest.current.active) return;
    if (shouldRefocusAfterNavigation(rootRef.current)) focusView(rootRef.current);
  }, [contentKey, latest, rootRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: entries 只作触发条件
  useEffect(() => {
    const { active: isActive, suspended } = latest.current;
    if (isActive && !suspended && isFocusLost()) focusView(rootRef.current);
  }, [entries, latest, rootRef]);

  /** 挂在根元素的 onBlur 上：焦点离开后无处可去（如筛选框按 Esc）时收回视图 */
  const onBlur = useCallback(
    (event: FocusEvent) => {
      if (event.relatedTarget !== null) return;
      requestAnimationFrame(() => {
        const { active: isActive, suspended } = latest.current;
        const root = rootRef.current;
        if (!root?.isConnected || !isActive || suspended) return;
        if (isFocusLost()) focusView(root);
      });
    },
    [latest, rootRef]
  );

  return { onBlur };
}

/** 新建 / 重命名后的条目闪一下。行的 className 归视图管，这里只在它稳定后临时加一个类。 */
export function useRowFlash(
  rootRef: RefObject<HTMLElement | null>,
  flashPath: string | null,
  armed: boolean
): void {
  useEffect(() => {
    if (flashPath === null || !armed) return;
    const row = findViewRow(rootRef.current, flashPath);
    if (!row) return;
    row.classList.add(FLASH_CLASS);
    return () => row.classList.remove(FLASH_CLASS);
  }, [rootRef, flashPath, armed]);
}
