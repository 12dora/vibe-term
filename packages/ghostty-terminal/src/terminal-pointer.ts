import { createPointerListeners } from './terminal-pointer-handlers';
import type { GhosttyViewportGesture } from './types';

export const GHOSTTY_MOUSE_BUTTON_LEFT = 1;
export const GHOSTTY_MOUSE_BUTTON_MIDDLE = 3;
export const GHOSTTY_MOUSE_BUTTON_RIGHT = 2;
export const GHOSTTY_MOUSE_BUTTON_FOUR = 4;
export const GHOSTTY_MOUSE_BUTTON_FIVE = 5;
export const GHOSTTY_MOUSE_BUTTON_SIX = 6;
export const GHOSTTY_MOUSE_BUTTON_SEVEN = 7;
// 触摸手势消费后的合成鼠标（compat mouse events）抑制窗口
export const SYNTHETIC_MOUSE_SUPPRESS_MS = 500;

export type InputRoutingState = {
  mouseReporting: boolean;
  altScroll: boolean;
};

export type MouseInputState = {
  pressedButtons: Set<number>;
  dragActive: boolean;
  reportBypassed: boolean;
  suppressSyntheticUntil: number;
  lastMotionCell: { col: number; row: number } | null;
};

export type MouseInputRequest = {
  action: 'press' | 'release' | 'motion';
  button?: number | null;
  clientX: number;
  clientY: number;
  mods: number;
  anyButtonPressed: boolean;
};

export type TerminalLinkHit = { kind: 'url'; url: string } | { kind: 'file'; path: string };

export type PointerEventContext = {
  readonly mouse: MouseInputState;
  isInputDisabled(): boolean;
  focusTerminal(): void;
  showScrollbarTransient(): void;
  getInputRoutingState(): InputRoutingState;
  isAnyEventTrackingEnabled(): boolean;
  pointerMods(event: {
    shiftKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
  }): number;
  emitMouseInput(request: MouseInputRequest): boolean;
  clearSelection(): void;
  linkAtClient(clientX: number, clientY: number): TerminalLinkHit | null;
  activateLink(hit: TerminalLinkHit): void;
  setLinkCursor(active: boolean): void;
  beginPointerSelection(event: MouseEvent): void;
  updatePointerSelection(event: MouseEvent): void;
  finishPointerSelection(event: MouseEvent): void;
  handleViewportGesture(gesture: GhosttyViewportGesture): boolean;
};

export function createMouseInputState(): MouseInputState {
  return {
    pressedButtons: new Set<number>(),
    dragActive: false,
    reportBypassed: false,
    suppressSyntheticUntil: 0,
    lastMotionCell: null,
  };
}

export function mouseButtonFromEvent(event: MouseEvent): number | null {
  switch (event.button) {
    case 0:
      return GHOSTTY_MOUSE_BUTTON_LEFT;
    case 1:
      return GHOSTTY_MOUSE_BUTTON_MIDDLE;
    case 2:
      return GHOSTTY_MOUSE_BUTTON_RIGHT;
    default:
      return null;
  }
}

export function mouseButtonFromButtons(buttons: number): number | null {
  if (buttons & 1) {
    return GHOSTTY_MOUSE_BUTTON_LEFT;
  }
  if (buttons & 4) {
    return GHOSTTY_MOUSE_BUTTON_MIDDLE;
  }
  if (buttons & 2) {
    return GHOSTTY_MOUSE_BUTTON_RIGHT;
  }

  return null;
}

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
