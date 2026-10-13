// 键盘快捷键：在浏览器根元素上挂一个原生 keydown 监听（不是 window），
// 这样既只管本标签页，又能赶在浏览器默认行为（mod+A / mod+F / mod+S / Alt+方向键 / Backspace）之前拦下。

import type { RefObject } from 'react';
import { useEffect } from 'react';
import type { ExplorerMenuCommand } from './actions';
import { isActivationKey, isActivationTarget } from './command-policy';
import {
  type ExplorerCommand,
  isApplePlatform,
  isEditableTarget,
  matchExplorerCommand,
} from './model';
import { useLatest } from './use-keyed-state';

export interface ExplorerKeyboardOptions {
  rootRef: RefObject<HTMLElement | null>;
  /** 本标签页是键盘属主 */
  active: boolean;
  /** 我们自己的对话框 / 菜单开着时让路 */
  suspended: boolean;
  /** 执行命令；返回 false 表示前提不满足、什么都没做 */
  run(command: ExplorerMenuCommand): boolean;
}

/** 这次按键要交给哪个命令；null = 不归我们管（原样放行）。 */
export function commandForKey(event: KeyboardEvent, apple: boolean): ExplorerCommand | null {
  if (event.defaultPrevented || event.isComposing) return null;
  // 输入框里的所有按键（含 Escape）都归输入框自己
  if (isEditableTarget(event.target)) return null;
  // 焦点在按钮 / 复选框这类控件上时，Enter 与空格（含带修饰键的组合）归控件自己
  if (isActivationKey(event.key) && isActivationTarget(event.target)) return null;
  return matchExplorerCommand(event, apple);
}

export function useExplorerKeyboard(options: ExplorerKeyboardOptions): void {
  const latest = useLatest(options);
  const { rootRef } = options;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const apple = isApplePlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      const { active, suspended, run } = latest.current;
      if (!active || suspended) return;
      const command = commandForKey(event, apple);
      if (command === null || !run(command)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, [rootRef, latest]);
}
