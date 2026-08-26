import { useEffect, useRef } from 'react';
import { MobileTouchGestureMachine } from './touch/gesture-machine';
import { isMobileTouchEnvironment } from './touch/touch-geometry';
import type { TerminalScroller } from './touch/types';

export function useMobileTouch(
  containerRef: React.RefObject<HTMLElement | null>,
  getTerminal?: () => TerminalScroller | null
) {
  const isActiveRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!isMobileTouchEnvironment(window)) return;

    isActiveRef.current = true;
    const machine = new MobileTouchGestureMachine({
      container,
      resolveTerminal: () => getTerminal?.() ?? null,
    });

    container.addEventListener('touchstart', machine.handleTouchStart, { passive: true });
    container.addEventListener('touchmove', machine.handleTouchMove, { passive: false });
    // touchend 需要 preventDefault（抑制 compat mouse 序列），不能 passive
    container.addEventListener('touchend', machine.handleTouchEnd, { passive: false });
    container.addEventListener('touchcancel', machine.handleTouchCancel, { passive: true });
    container.addEventListener('contextmenu', machine.handleContextMenu);

    return () => {
      isActiveRef.current = false;
      machine.dispose();
      container.removeEventListener('touchstart', machine.handleTouchStart);
      container.removeEventListener('touchmove', machine.handleTouchMove);
      container.removeEventListener('touchend', machine.handleTouchEnd);
      container.removeEventListener('touchcancel', machine.handleTouchCancel);
      container.removeEventListener('contextmenu', machine.handleContextMenu);
    };
  }, [containerRef, getTerminal]);

  return isActiveRef;
}
