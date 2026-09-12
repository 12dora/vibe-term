import type { CompatibleTerminalLike } from 'ghostty-terminal';
import { type RefObject, useCallback, useLayoutEffect, useState } from 'react';
import { placeSelectionToolbar } from '../selection-anchor';

const TOOLBAR_GAP = 8;

export function useSelectionAnchor({
  instance,
  containerRef,
  toolbarRef,
  hasSelection,
}: {
  instance: CompatibleTerminalLike | null;
  containerRef: RefObject<HTMLElement | null>;
  toolbarRef: RefObject<HTMLElement | null>;
  hasSelection: boolean;
}): { left: number; top: number } | null {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);

  const recompute = useCallback(() => {
    if (!hasSelection) {
      setAnchor(null);
      return;
    }
    const container = containerRef.current;
    const toolbar = toolbarRef.current;
    const selection = instance?.getSelectionViewportRect?.() ?? null;
    if (!container || !toolbar || !selection) {
      setAnchor(null);
      return;
    }
    const toolbarRect = toolbar.getBoundingClientRect();
    if (toolbarRect.width <= 0 || toolbarRect.height <= 0) {
      setAnchor(null);
      return;
    }
    const placed = placeSelectionToolbar({
      selection,
      container: container.getBoundingClientRect(),
      toolbar: { width: toolbarRect.width, height: toolbarRect.height },
      gap: TOOLBAR_GAP,
    });
    setAnchor({ left: placed.left, top: placed.top });
  }, [containerRef, hasSelection, instance, toolbarRef]);

  useLayoutEffect(() => {
    if (!hasSelection) {
      setAnchor(null);
      return;
    }

    recompute();
    let rafId: number | null = null;
    const scheduleRecompute = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        recompute();
      });
    };
    scheduleRecompute();
    const container = containerRef.current;
    const observers: ResizeObserver[] = [];

    if (typeof ResizeObserver === 'function' && container) {
      const ro = new ResizeObserver(() => recompute());
      ro.observe(container);
      observers.push(ro);
    }

    const onLayout = () => recompute();
    const view = typeof window === 'undefined' ? null : window;
    view?.addEventListener('scroll', onLayout, { capture: true, passive: true });
    view?.addEventListener('resize', onLayout);
    view?.visualViewport?.addEventListener('resize', onLayout);
    view?.visualViewport?.addEventListener('scroll', onLayout);
    container?.addEventListener('scroll', onLayout, { capture: true, passive: true });

    const disposable = instance?.onSelectionChange?.(scheduleRecompute);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      for (const observer of observers) observer.disconnect();
      view?.removeEventListener('scroll', onLayout, true);
      view?.removeEventListener('resize', onLayout);
      view?.visualViewport?.removeEventListener('resize', onLayout);
      view?.visualViewport?.removeEventListener('scroll', onLayout);
      container?.removeEventListener('scroll', onLayout, true);
      disposable?.dispose();
    };
  }, [containerRef, hasSelection, instance, recompute]);

  return hasSelection ? anchor : null;
}
