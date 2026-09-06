// 软键盘开关按钮的首帧形态：bun test 无 DOM，用静态渲染断言可访问名与测试锚点。
import { describe, expect, test } from 'bun:test';
import type { TerminalRef } from '@tmex/terminal-ui';
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TerminalKeyboardButton } from './terminal-keyboard-button';

describe('TerminalKeyboardButton', () => {
  test('未聚焦时是「显示键盘」，并且不抢焦点', () => {
    const html = renderToStaticMarkup(
      <TerminalKeyboardButton terminalRef={createRef<TerminalRef>()} disabled={false} />
    );
    expect(html).toContain('data-testid="terminal-keyboard-toggle"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('terminal.showKeyboard');
  });

  test('pane 不可交互时按钮禁用', () => {
    const html = renderToStaticMarkup(
      <TerminalKeyboardButton terminalRef={createRef<TerminalRef>()} disabled />
    );
    expect(html).toContain('disabled=""');
  });
});
