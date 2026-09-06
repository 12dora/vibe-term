// 收起软键盘的按钮：只在终端输入元素持有焦点（键盘弹着）时出现在快捷键栏最左侧。
// 唤起键盘不需要按钮——点终端的输入行（光标所在行）即可，见 docs/architecture/mobile-keyboard.md。

import { type TerminalRef, blurTerminalInput, isTerminalInputFocused } from '@vibeterm/terminal-ui';
import { Button } from '@vibeterm/ui/button';
import { KeyboardOff } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface TerminalHideKeyboardButtonProps {
  terminalRef: RefObject<TerminalRef | null>;
}

/** 终端输入元素是否持有焦点（触屏上即软键盘是否弹着）；focusin/focusout 覆盖全部转移路径 */
export function useTerminalInputFocused(
  terminalRef: RefObject<TerminalRef | null> | null
): boolean {
  const [focused, setFocused] = useState(() =>
    isTerminalInputFocused(terminalRef?.current?.getTerminal())
  );

  useEffect(() => {
    const sync = (): void => {
      setFocused(isTerminalInputFocused(terminalRef?.current?.getTerminal()));
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

export function TerminalHideKeyboardButton({ terminalRef }: TerminalHideKeyboardButtonProps) {
  const { t } = useTranslation();
  const focused = useTerminalInputFocused(terminalRef);

  const hide = useCallback(() => {
    blurTerminalInput(terminalRef.current?.getTerminal());
  }, [terminalRef]);

  if (!focused) {
    return null;
  }

  const label = t('terminal.hideKeyboard');
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="terminal-shortcut-btn h-8 w-9 shrink-0 rounded-full [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:w-10"
      title={label}
      aria-label={label}
      data-testid="terminal-keyboard-hide"
      // 按钮自身不接管焦点：iOS 上焦点一转移键盘就收起，收键盘完全由 onClick 决定
      onMouseDown={(event) => event.preventDefault()}
      onClick={hide}
    >
      <KeyboardOff className="h-4 w-4" />
    </Button>
  );
}
