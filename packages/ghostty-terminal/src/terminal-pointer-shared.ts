// terminal-pointer 与 terminal-pointer-handlers 共用的按钮常量、输入状态与 context 契约。
// 单独成叶子模块，避免注册层（terminal-pointer）与监听器层（terminal-pointer-handlers）互相 import。

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
