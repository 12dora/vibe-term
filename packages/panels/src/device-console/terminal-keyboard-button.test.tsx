// 「隐藏键盘」按钮只在终端输入元素持有焦点时出现。bun test 无 DOM，
// 用 react-dom/server 静态渲染断言首帧形态，焦点态靠桩 document.activeElement 驱动。
// 同进程其他测试可能初始化全局 i18next，这里用独立实例注入，文案断言与文件顺序无关。
import { afterEach, describe, expect, test } from 'bun:test';
import { I18N_RESOURCES } from '@vibeterm/shared';
import type { TerminalRef } from '@vibeterm/terminal-ui';
import i18next from 'i18next';
import type { RefObject } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { TerminalHideKeyboardButton } from './terminal-keyboard-button';

const globals = globalThis as unknown as { document?: unknown };
const savedDocument = globals.document;

afterEach(() => {
  globals.document = savedDocument;
});

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'en_US',
  fallbackLng: 'en_US',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const textarea = {};

function render(terminalRef: RefObject<TerminalRef | null>): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <TerminalHideKeyboardButton terminalRef={terminalRef} />
    </I18nextProvider>
  );
}

function terminalRef(): RefObject<TerminalRef | null> {
  return {
    current: { getTerminal: () => ({ textarea }) } as unknown as TerminalRef,
  };
}

describe('TerminalHideKeyboardButton', () => {
  test('键盘未弹起（输入元素无焦点）时不渲染', () => {
    globals.document = { activeElement: null };
    expect(render(terminalRef())).toBe('');
  });

  test('键盘弹着时渲染「隐藏键盘」，且不抢焦点', () => {
    globals.document = { activeElement: textarea };
    const html = render(terminalRef());
    const label = i18n.t('terminal.hideKeyboard');
    expect(label).not.toBe('terminal.hideKeyboard');
    expect(html).toContain('data-testid="terminal-keyboard-hide"');
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`title="${label}"`);
  });
});
