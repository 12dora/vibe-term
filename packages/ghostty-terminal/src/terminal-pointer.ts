import { createPointerListeners } from './terminal-pointer-handlers';
import type { PointerEventContext } from './terminal-pointer-shared';

export {
  GHOSTTY_MOUSE_BUTTON_FIVE,
  GHOSTTY_MOUSE_BUTTON_FOUR,
  GHOSTTY_MOUSE_BUTTON_LEFT,
  GHOSTTY_MOUSE_BUTTON_MIDDLE,
  GHOSTTY_MOUSE_BUTTON_RIGHT,
  GHOSTTY_MOUSE_BUTTON_SEVEN,
  GHOSTTY_MOUSE_BUTTON_SIX,
  SYNTHETIC_MOUSE_SUPPRESS_MS,
  createMouseInputState,
  mouseButtonFromButtons,
  mouseButtonFromEvent,
} from './terminal-pointer-shared';
export type {
  InputRoutingState,
  MouseInputRequest,
  MouseInputState,
  PointerEventContext,
  TerminalLinkHit,
} from './terminal-pointer-shared';

// 只负责注册 / 注销：监听器行为在 terminal-pointer-handlers 里。
// 注册顺序与 window 级拖拽监听是行为契约的一部分，不得调整。
export function bindMouseEvents(
  root: HTMLElement,
  selectSurface: HTMLElement,
  context: PointerEventContext
): () => void {
  const listeners = createPointerListeners(context);

  root.addEventListener('click', listeners.click);
  selectSurface.addEventListener('mousedown', listeners.mousedown);
  selectSurface.addEventListener('mousemove', listeners.mousemove);
  selectSurface.addEventListener('mouseleave', listeners.mouseleave);
  root.addEventListener('wheel', listeners.wheel, { passive: false });

  const dragEventTarget =
    typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
  if (dragEventTarget) {
    dragEventTarget.addEventListener('mousemove', listeners.dragMove);
    dragEventTarget.addEventListener('mouseup', listeners.dragUp);
  }

  return () => {
    root.removeEventListener('click', listeners.click);
    selectSurface.removeEventListener('mousedown', listeners.mousedown);
    selectSurface.removeEventListener('mousemove', listeners.mousemove);
    selectSurface.removeEventListener('mouseleave', listeners.mouseleave);
    root.removeEventListener('wheel', listeners.wheel);
    if (dragEventTarget) {
      dragEventTarget.removeEventListener('mousemove', listeners.dragMove);
      dragEventTarget.removeEventListener('mouseup', listeners.dragUp);
    }
  };
}
