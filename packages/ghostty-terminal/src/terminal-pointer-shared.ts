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

export type TerminalCellPoint = { line: number; col: number };

export type PointerClientPoint = { clientX: number; clientY: number };

/** 无修饰单击按下时命中的链接：松开仍在同一格才打开。 */
export type PendingLinkClick = TerminalCellPoint & { hit: TerminalLinkHit };

/** 悬停判定的输入快照：格子与修饰键状态都没变时不重算光标/提示。 */
export type LinkHoverKey = TerminalCellPoint & {
  platform: boolean;
  other: boolean;
  shift: boolean;
  reporting: boolean;
};

/**
 * 主键（左键）这次按下属于哪种手势，只由 terminal-pointer-gesture 改写：
 * selection 本地选区（含 Shift 绕过上报）；reported 按下已上报给应用；
 * swallowed 上报模式下按在 OSC 8 链接上，整次手势不上报；opened 修饰键按下已打开链接。
 */
export type PrimaryGesture = 'none' | 'selection' | 'reported' | 'swallowed' | 'opened';

export type MouseInputState = {
  // 已向应用上报过 press、尚未上报 release 的按键（Ghostty 按键编号）
  pressedButtons: Set<number>;
  primary: PrimaryGesture;
  suppressSyntheticUntil: number;
  lastMotionCell: { col: number; row: number } | null;
  pendingLink: PendingLinkClick | null;
  linkHover: LinkHoverKey | null;
};

export type MouseInputRequest = {
  action: 'press' | 'release' | 'motion';
  button?: number | null;
  clientX: number;
  clientY: number;
  mods: number;
  anyButtonPressed: boolean;
};

export type TerminalLinkTarget = { kind: 'url'; url: string } | { kind: 'file'; path: string };

/** explicit：来自 OSC 8；tooltip 仅在可见文本与 URI 不一致的 explicit url 上给出。 */
export type TerminalLinkHit = TerminalLinkTarget & { explicit: boolean; tooltip?: string };

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
  cellAtClient(clientX: number, clientY: number): TerminalCellPoint | null;
  linkAtClient(clientX: number, clientY: number): TerminalLinkHit | null;
  activateLink(hit: TerminalLinkHit): void;
  setLinkCursor(active: boolean, title: string | null): void;
  beginPointerSelection(event: MouseEvent): void;
  updatePointerSelection(event: MouseEvent): void;
  finishPointerSelection(point: PointerClientPoint): void;
  handleViewportGesture(gesture: GhosttyViewportGesture): boolean;
};

export function createMouseInputState(): MouseInputState {
  return {
    pressedButtons: new Set<number>(),
    primary: 'none',
    suppressSyntheticUntil: 0,
    lastMotionCell: null,
    pendingLink: null,
    linkHover: null,
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
