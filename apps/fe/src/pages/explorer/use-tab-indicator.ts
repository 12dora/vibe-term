// 活动标签页底部那条滑动指示条：跟着活动标签页的实测位置走，首帧不带过渡。

import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useState } from 'react';

interface IndicatorRect {
  left: number;
  width: number;
}

export interface TabIndicator {
  /** null = 没有活动标签页或还没量到 */
  style: CSSProperties | null;
  /** 首次定位之后才开过渡，避免从 0 滑进来 */
  animated: boolean;
}

function findTab(row: HTMLElement, tabId: string): HTMLElement | null {
  for (const child of Array.from(row.children)) {
    if (child instanceof HTMLElement && child.dataset.tabId === tabId) return child;
  }
  return null;
}

function sameRect(a: IndicatorRect | null, b: IndicatorRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.left === b.left && a.width === b.width;
}

/**
 * @param rowRef 标签行（指示条的定位父级，标签页是它的直接子元素）
 * @param layoutKey 标签顺序的指纹：顺序 / 数量变化时重新测量
 */
export function useTabIndicator(
  rowRef: RefObject<HTMLElement | null>,
  activeTabId: string | null,
  layoutKey: string
): TabIndicator {
  const [rect, setRect] = useState<IndicatorRect | null>(null);
  const [animated, setAnimated] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutKey 是「标签顺序变了」的显式触发器
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => {
      const tab = activeTabId ? findTab(row, activeTabId) : null;
      const next = tab ? { left: tab.offsetLeft, width: tab.offsetWidth } : null;
      setRect((prev) => (sameRect(prev, next) ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    // 标签页入场动画、标题变长、相邻标签页增减都会挪动活动标签页
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    for (const child of Array.from(row.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [rowRef, activeTabId, layoutKey]);

  const located = rect !== null;
  useEffect(() => {
    if (!located) {
      setAnimated(false);
      return;
    }
    // 等首帧定位画出来之后再开过渡
    const frame = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(frame);
  }, [located]);

  if (!rect) return { style: null, animated: false };
  return {
    style: { transform: `translateX(${rect.left}px)`, width: rect.width },
    animated,
  };
}
