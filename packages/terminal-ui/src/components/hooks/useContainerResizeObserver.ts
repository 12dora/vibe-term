// 容器尺寸观察：observe 会立刻投递一次当前尺寸，而首屏的 post-select 上报已经量过
// 同一个盒子，尺寸没变就不必再排一轮防抖测量。

import { type RefObject, useEffect } from 'react';

export function useContainerResizeObserver(
  containerRef: RefObject<HTMLDivElement | null>,
  lastMeasuredRect: RefObject<{ width: number; height: number } | null>,
  scheduleResize: () => void
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let rafId: number | null = null;
    let initialObservation = true;

    const ro = new ResizeObserver(() => {
      if (initialObservation) {
        initialObservation = false;
        const measured = lastMeasuredRect.current;
        const rect = el.getBoundingClientRect();
        if (
          measured &&
          Math.abs(rect.width - measured.width) < 0.5 &&
          Math.abs(rect.height - measured.height) < 0.5
        ) {
          return;
        }
      }
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        scheduleResize();
      });
    });

    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [containerRef, lastMeasuredRect, scheduleResize]);
}
