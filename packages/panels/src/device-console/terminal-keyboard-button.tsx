// 触屏软键盘开关：终端画布上的轻点不再唤起键盘（只滚动 / 长按选择），
// 键盘由这颗按钮显式开合。桌面不渲染——鼠标点终端即可输入。

import {
  type TerminalRef,
  blurTerminalInput,
  focusTerminalInput,
  isTerminalInputFocused,
} from '@tmex/terminal-ui';
import { Button } from '@tmex/ui/button';
import { Keyboard, KeyboardOff } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface TerminalKeyboardButtonProps {
  terminalRef: RefObject<TerminalRef | null>;
  disabled: boolean;
}

/** 终端输入元素是否持有焦点（触屏上即软键盘是否弹着）；focusin/focusout 覆盖全部转移路径 */
function useTerminalInputFocused(terminalRef: RefObject<TerminalRef | null>): boolean {
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const sync = (): void => {
      setFocused(isTerminalInputFocused(terminalRef.current?.getTerminal()));
    };
    sync();
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', sync);
    return () => {
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', sync);
    };
  }, [terminalRef]);

  return focused;
}

export function TerminalKeyboardButton({ terminalRef, disabled }: TerminalKeyboardButtonProps) {
  const { t } = useTranslation();
  const focused = useTerminalInputFocused(terminalRef);
  const label = focused ? t('terminal.hideKeyboard') : t('terminal.showKeyboard');
  const Icon = focused ? KeyboardOff : Keyboard;

  const toggle = useCallback(() => {
    const terminal = terminalRef.current?.getTerminal() ?? null;
    if (isTerminalInputFocused(terminal)) {
      blurTerminalInput(terminal);
      return;
    }
    focusTerminalInput(terminal);
  }, [terminalRef]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="terminal-shortcut-btn h-8 w-9 shrink-0 rounded-full [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:w-10"
      title={label}
      aria-label={label}
      aria-pressed={focused}
      data-testid="terminal-keyboard-toggle"
      // 按钮自身不接管焦点：iOS 上焦点一旦转移软键盘就收起，开合完全由 onClick 决定
      onMouseDown={(event) => event.preventDefault()}
      onClick={toggle}
      disabled={disabled}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
