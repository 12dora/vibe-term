// 终端输入焦点（= 触屏软键盘的开关）的统一入口。
//
// 触屏上聚焦 helper textarea 就等于弹出软键盘，因此隐式聚焦——挂载自动聚焦、切 pane 回焦、
// 复制/粘贴后回焦、画布上的轻点——一律跳过，键盘只由快捷键栏的「显示键盘」唤起。
// 桌面没有这个副作用，行为保持不变。

import type { CompatibleTerminalLike } from 'ghostty-terminal';
import { MOBILE_VIEWPORT_MAX_WIDTH_PX } from '../components/touch/touch-geometry';

/** 触屏优先环境：窄视口或带触摸能力（与 useMobileViewport 的判定同源） */
export function isTouchFirstEnvironment(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.innerWidth < MOBILE_VIEWPORT_MAX_WIDTH_PX || 'ontouchstart' in window;
}

function inputElement(terminal: CompatibleTerminalLike | null | undefined): HTMLElement | null {
  return terminal?.textarea ?? null;
}

export function isTerminalInputFocused(
  terminal: CompatibleTerminalLike | null | undefined
): boolean {
  const element = inputElement(terminal);
  if (!element || typeof document === 'undefined') {
    return false;
  }
  return document.activeElement === element;
}

export function focusTerminalInput(terminal: CompatibleTerminalLike | null | undefined): void {
  terminal?.focus();
}

export function blurTerminalInput(terminal: CompatibleTerminalLike | null | undefined): void {
  inputElement(terminal)?.blur();
}

/** 隐式回焦：触屏跳过（会弹键盘），桌面照旧 */
export function refocusTerminalInput(terminal: CompatibleTerminalLike | null | undefined): void {
  if (isTouchFirstEnvironment()) {
    return;
  }
  focusTerminalInput(terminal);
}
