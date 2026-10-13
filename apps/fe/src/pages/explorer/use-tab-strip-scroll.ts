// 标签栏的横向滚动：滚轮纵向转横向、两端溢出时的渐隐遮罩、活动标签页自动滚入视野。

import {
  type CSSProperties,
  type RefObject,
  type WheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';

const FADE_PX = 20;

interface Overflow {
  start: boolean;
  end: boolean;
}

const NO_OVERFLOW: Overflow = { start: false, end: false };

function readOverflow(el: HTMLElement): Overflow {
  const max = el.scrollWidth - el.clientWidth;
  return { start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 };
}

/** 两端各自只在还有内容没露出来时才渐隐 */
export function stripMaskStyle(overflow: Overflow): CSSProperties | undefined {
  if (!overflow.start && !overflow.end) return undefined;
  const from = overflow.start ? 'transparent' : '#000';
  const to = overflow.end ? 'transparent' : '#000';
  const stops = [from, `#000 ${FADE_PX}px`, `#000 calc(100% - ${FADE_PX}px)`, to];
  const mask = `linear-gradient(to right, ${stops.join(', ')})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

export interface TabStripScroll {
  maskStyle: CSSProperties | undefined;
  onScroll(): void;
  onWheel(event: WheelEvent<HTMLElement>): void;
}

export function useTabStripScroll(
  scrollRef: RefObject<HTMLElement | null>,
  activeTabId: string | null,
  layoutKey: string
): TabStripScroll {
  const [overflow, setOverflow] = useState<Overflow>(NO_OVERFLOW);

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = readOverflow(el);
    setOverflow((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, [scrollRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutKey 是「标签数量变了」的显式触发器
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [scrollRef, update, layoutKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeTabId) return;
    const tabs = Array.from(el.querySelectorAll<HTMLElement>('[data-tab-id]'));
    const tab = tabs.find((item) => item.dataset.tabId === activeTabId);
    if (typeof tab?.scrollIntoView !== 'function') return;
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [scrollRef, activeTabId]);

  const onWheel = useCallback((event: WheelEvent<HTMLElement>) => {
    // 触控板本身的横向滚动交给浏览器；鼠标滚轮的纵向量转成横向
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.currentTarget.scrollLeft += event.deltaY;
  }, []);

  return { maskStyle: stripMaskStyle(overflow), onScroll: update, onWheel };
}
