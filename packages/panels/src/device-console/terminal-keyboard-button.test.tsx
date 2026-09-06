// 「隐藏键盘」按钮只在终端输入元素持有焦点时出现。bun test 无 DOM，
// 用 react-dom/server 静态渲染断言首帧形态，焦点态靠桩 document.activeElement 驱动。
import { afterEach, describe, expect, test } from 'bun:test';
import type { TerminalRef } from '@vibeterm/terminal-ui';
import type { RefObject } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TerminalHideKeyboardButton } from './terminal-keyboard-button';

const globals = globalThis as unknown as { document?: unknown };
const savedDocument = globals.document;

afterEach(() => {
  globals.document = savedDocument;
});

const textarea = {};

function terminalRef(): RefObject<TerminalRef | null> {
  return {
    current: { getTerminal: () => ({ textarea }) } as unknown as TerminalRef,
  };
}

describe('TerminalHideKeyboardButton', () => {
  test('键盘未弹起（输入元素无焦点）时不渲染', () => {
    globals.document = { activeElement: null };
    expect(renderToStaticMarkup(<TerminalHideKeyboardButton terminalRef={terminalRef()} />)).toBe(
      ''
    );
  });

  test('键盘弹着时渲染「隐藏键盘」，且不抢焦点', () => {
    globals.document = { activeElement: textarea };
    const html = renderToStaticMarkup(<TerminalHideKeyboardButton terminalRef={terminalRef()} />);
    expect(html).toContain('data-testid="terminal-keyboard-hide"');
    expect(html).toContain('terminal.hideKeyboard');
  });
});
