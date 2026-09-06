// 终端输入焦点判定：触屏上聚焦 = 弹软键盘，所以隐式回焦必须按环境分流。
import { afterEach, describe, expect, test } from 'bun:test';
import type { CompatibleTerminalLike } from 'ghostty-terminal';
import {
  blurTerminalInput,
  isTerminalInputFocused,
  isTouchFirstEnvironment,
  refocusTerminalInput,
} from './terminal-input-focus';

interface StubGlobals {
  window?: unknown;
  document?: unknown;
}

const globals = globalThis as unknown as StubGlobals;
const savedWindow = globals.window;
const savedDocument = globals.document;

afterEach(() => {
  globals.window = savedWindow;
  globals.document = savedDocument;
});

function setEnvironment(options: { innerWidth: number; touch: boolean }): void {
  const view: Record<string, unknown> = { innerWidth: options.innerWidth };
  if (options.touch) {
    view.ontouchstart = null;
  }
  globals.window = view;
}

function createTerminal(): {
  terminal: CompatibleTerminalLike;
  textarea: { blur: () => void };
  calls: string[];
} {
  const calls: string[] = [];
  const textarea = { blur: () => calls.push('blur') };
  const terminal = {
    textarea,
    focus: () => calls.push('focus'),
  } as unknown as CompatibleTerminalLike;
  return { terminal, textarea, calls };
}

describe('isTouchFirstEnvironment', () => {
  test('窄视口即触屏优先', () => {
    setEnvironment({ innerWidth: 390, touch: false });
    expect(isTouchFirstEnvironment()).toBe(true);
  });

  test('宽视口带触摸能力（平板 / 触屏本）同样算触屏优先', () => {
    setEnvironment({ innerWidth: 1280, touch: true });
    expect(isTouchFirstEnvironment()).toBe(true);
  });

  test('宽视口纯鼠标是桌面', () => {
    setEnvironment({ innerWidth: 1280, touch: false });
    expect(isTouchFirstEnvironment()).toBe(false);
  });
});

describe('refocusTerminalInput', () => {
  test('桌面：隐式回焦照常执行', () => {
    setEnvironment({ innerWidth: 1280, touch: false });
    const { terminal, calls } = createTerminal();
    refocusTerminalInput(terminal);
    expect(calls).toEqual(['focus']);
  });

  test('触屏：隐式回焦跳过，不弹软键盘', () => {
    setEnvironment({ innerWidth: 390, touch: false });
    const { terminal, calls } = createTerminal();
    refocusTerminalInput(terminal);
    expect(calls).toEqual([]);
  });
});

describe('显式开合', () => {
  test('blur 作用在输入元素上（触屏上即收起软键盘）', () => {
    const { terminal, calls } = createTerminal();
    blurTerminalInput(terminal);
    expect(calls).toEqual(['blur']);
  });

  test('聚焦状态按 activeElement 判定', () => {
    const { terminal, textarea } = createTerminal();
    globals.document = { activeElement: textarea };
    expect(isTerminalInputFocused(terminal)).toBe(true);
    globals.document = { activeElement: null };
    expect(isTerminalInputFocused(terminal)).toBe(false);
    expect(isTerminalInputFocused(null)).toBe(false);
  });
});
