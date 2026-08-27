import { describe, expect, test } from 'bun:test';
import {
  type CapturedShortcut,
  type KeyChord,
  escapeForDisplay,
  keyEventToTerminalSequence,
  labelToSymbols,
  parseEscapeSequence,
} from './terminalKeySequence';

describe('keyEventToTerminalSequence', () => {
  test('Ctrl+C → \\x03 / CTRL-C', () => {
    expect(keyEventToTerminalSequence({ key: 'c', ctrlKey: true })).toEqual({
      label: 'CTRL-C',
      payload: '\x03',
    });
  });
  test('Ctrl+A → \\x01', () => {
    expect(keyEventToTerminalSequence({ key: 'a', ctrlKey: true })?.payload).toBe('\x01');
  });
  test('Ctrl+D → \\x04', () => {
    expect(keyEventToTerminalSequence({ key: 'd', ctrlKey: true })?.payload).toBe('\x04');
  });
  test('ArrowUp → CSI A / ↑', () => {
    expect(keyEventToTerminalSequence({ key: 'ArrowUp' })).toEqual({
      label: '↑',
      payload: '\x1b[A',
    });
  });
  test('Ctrl+ArrowRight → CSI 1;5C', () => {
    expect(keyEventToTerminalSequence({ key: 'ArrowRight', ctrlKey: true })).toEqual({
      label: 'CTRL-→',
      payload: '\x1b[1;5C',
    });
  });
  test('Shift+Tab → CSI Z', () => {
    expect(keyEventToTerminalSequence({ key: 'Tab', shiftKey: true })).toEqual({
      label: 'SHIFT-Tab',
      payload: '\x1b[Z',
    });
  });
  test('Shift+Enter → CSI 13;2u', () => {
    expect(keyEventToTerminalSequence({ key: 'Enter', shiftKey: true })).toEqual({
      label: 'SHIFT-Enter',
      payload: '\x1b[13;2u',
    });
  });
  test('Enter → \\r', () => {
    expect(keyEventToTerminalSequence({ key: 'Enter' })).toEqual({ label: 'Enter', payload: '\r' });
  });
  test('Escape → \\x1b / ESC', () => {
    expect(keyEventToTerminalSequence({ key: 'Escape' })).toEqual({
      label: 'ESC',
      payload: '\x1b',
    });
  });
  test('Tab → \\t', () => {
    expect(keyEventToTerminalSequence({ key: 'Tab' })).toEqual({ label: 'Tab', payload: '\t' });
  });
  test('Backspace → \\x08', () => {
    expect(keyEventToTerminalSequence({ key: 'Backspace' })?.payload).toBe('\x08');
  });
  test('Delete → CSI 3~', () => {
    expect(keyEventToTerminalSequence({ key: 'Delete' })).toEqual({
      label: 'Delete',
      payload: '\x1b[3~',
    });
  });
  test('F5 → CSI 15~', () => {
    expect(keyEventToTerminalSequence({ key: 'F5' })).toEqual({ label: 'F5', payload: '\x1b[15~' });
  });
  test('F1 → SS3 P', () => {
    expect(keyEventToTerminalSequence({ key: 'F1' })).toEqual({ label: 'F1', payload: '\x1bOP' });
  });
  test('Alt+x → ESC x / ALT-X', () => {
    expect(keyEventToTerminalSequence({ key: 'x', altKey: true })).toEqual({
      label: 'ALT-X',
      payload: '\x1bx',
    });
  });
  test('普通字符 a → a', () => {
    expect(keyEventToTerminalSequence({ key: 'a' })).toEqual({ label: 'a', payload: 'a' });
  });
  test('符号 : → :', () => {
    expect(keyEventToTerminalSequence({ key: ':' })).toEqual({ label: ':', payload: ':' });
  });
  test('纯修饰键 Control → null', () => {
    expect(keyEventToTerminalSequence({ key: 'Control', ctrlKey: true })).toBeNull();
  });
  test('Ctrl+无控制码字符（Ctrl+1）→ null', () => {
    expect(keyEventToTerminalSequence({ key: '1', ctrlKey: true })).toBeNull();
  });
  test('Ctrl+[（有控制码）→ \\x1b', () => {
    expect(keyEventToTerminalSequence({ key: '[', ctrlKey: true })?.payload).toBe('\x1b');
  });
});

describe('keyEventToTerminalSequence 查表覆盖', () => {
  const cases: Array<[string, KeyChord, CapturedShortcut | null]> = [
    // 方向键 / Home / End（csiFinal）
    ['ArrowDown', { key: 'ArrowDown' }, { label: '↓', payload: '\x1b[B' }],
    ['ArrowLeft', { key: 'ArrowLeft' }, { label: '←', payload: '\x1b[D' }],
    ['Home', { key: 'Home' }, { label: 'Home', payload: '\x1b[H' }],
    ['End', { key: 'End' }, { label: 'End', payload: '\x1b[F' }],
    ['Shift+Home', { key: 'Home', shiftKey: true }, { label: 'SHIFT-Home', payload: '\x1b[1;2H' }],
    [
      'Cmd+ArrowLeft',
      { key: 'ArrowLeft', metaKey: true },
      { label: 'CMD-←', payload: '\x1b[1;9D' },
    ],
    [
      'Ctrl+Alt+ArrowUp',
      { key: 'ArrowUp', ctrlKey: true, altKey: true },
      { label: 'CTRL-ALT-↑', payload: '\x1b[1;7A' },
    ],
    // csiNum 系
    ['Insert', { key: 'Insert' }, { label: 'Insert', payload: '\x1b[2~' }],
    ['PageUp', { key: 'PageUp' }, { label: 'PgUp', payload: '\x1b[5~' }],
    ['PageDown', { key: 'PageDown' }, { label: 'PgDn', payload: '\x1b[6~' }],
    [
      'Shift+Delete',
      { key: 'Delete', shiftKey: true },
      { label: 'SHIFT-Delete', payload: '\x1b[3;2~' },
    ],
    // raw 系（Alt 前置 ESC）
    ['Space', { key: ' ' }, { label: 'Space', payload: ' ' }],
    ['Alt+Space', { key: ' ', altKey: true }, { label: 'ALT-Space', payload: '\x1b ' }],
    ['Alt+Enter', { key: 'Enter', altKey: true }, { label: 'ALT-Enter', payload: '\x1b\r' }],
    // Shift 专属组合只在纯 Shift 时生效，带别的修饰键回落到命名键
    [
      'Ctrl+Shift+Tab',
      { key: 'Tab', ctrlKey: true, shiftKey: true },
      { label: 'CTRL-SHIFT-Tab', payload: '\t' },
    ],
    // 功能键
    ['F3', { key: 'F3' }, { label: 'F3', payload: '\x1bOR' }],
    ['F12', { key: 'F12' }, { label: 'F12', payload: '\x1b[24~' }],
    ['Shift+F5', { key: 'F5', shiftKey: true }, { label: 'SHIFT-F5', payload: '\x1b[15~' }],
    // Ctrl + 符号控制码
    ['Ctrl+\\', { key: '\\', ctrlKey: true }, { label: 'CTRL-\\', payload: '\x1c' }],
    ['Ctrl+]', { key: ']', ctrlKey: true }, { label: 'CTRL-]', payload: '\x1d' }],
    ['Ctrl+^', { key: '^', ctrlKey: true }, { label: 'CTRL-^', payload: '\x1e' }],
    ['Ctrl+_', { key: '_', ctrlKey: true }, { label: 'CTRL-_', payload: '\x1f' }],
    ['Ctrl+@', { key: '@', ctrlKey: true }, { label: 'CTRL-@', payload: '\x00' }],
    ['Ctrl+?', { key: '?', ctrlKey: true }, { label: 'CTRL-?', payload: '\x7f' }],
    // Ctrl+Alt+字母不落 Ctrl 控制码分支，且无符号控制码 → 拒绝捕获
    ['Ctrl+Alt+x', { key: 'x', ctrlKey: true, altKey: true }, null],
    // Cmd+字母不产生控制序列，按裸字符处理（沿用既有行为）
    ['Cmd+c', { key: 'c', metaKey: true }, { label: 'c', payload: 'c' }],
    // 不可识别
    ['空 key', { key: '' }, null],
    ['Unidentified', { key: 'Unidentified' }, null],
    ['未知多字符键', { key: 'AudioVolumeUp' }, null],
  ];

  for (const [name, chord, expected] of cases) {
    test(name, () => {
      expect(keyEventToTerminalSequence(chord)).toEqual(expected);
    });
  }
});

describe('parseEscapeSequence', () => {
  test('\\x1b[A → ESC [A', () => {
    expect(parseEscapeSequence('\\x1b[A')).toBe('\x1b[A');
  });
  test('\\u0003 → \\x03', () => {
    expect(parseEscapeSequence('\\u0003')).toBe('\x03');
  });
  test('\\r \\n \\t \\e 转义', () => {
    expect(parseEscapeSequence('\\r')).toBe('\r');
    expect(parseEscapeSequence('\\n')).toBe('\n');
    expect(parseEscapeSequence('\\t')).toBe('\t');
    expect(parseEscapeSequence('\\e')).toBe('\x1b');
  });
  test('无转义原样返回', () => {
    expect(parseEscapeSequence('abc')).toBe('abc');
  });
  test('非法 / 不完整转义不注入 NUL', () => {
    expect(parseEscapeSequence('test\\xGG')).not.toContain('\x00');
    expect(parseEscapeSequence('\\u003')).not.toContain('\x00');
    expect(parseEscapeSequence('\\x')).not.toContain('\x00');
  });
  test('\\\\ → 单反斜杠', () => {
    expect(parseEscapeSequence('\\\\')).toBe('\\');
  });
});

describe('escapeForDisplay 与 parseEscapeSequence 往返', () => {
  test('ESC 序列 → \\e[A 且可逆', () => {
    expect(escapeForDisplay('\x1b[A')).toBe('\\e[A');
    expect(parseEscapeSequence('\\e[A')).toBe('\x1b[A');
  });
  test('控制码 → \\x03 且可逆', () => {
    expect(escapeForDisplay('\x03')).toBe('\\x03');
    expect(parseEscapeSequence('\\x03')).toBe('\x03');
  });
  test('普通文本原样', () => {
    expect(escapeForDisplay('ls -la')).toBe('ls -la');
  });
  test('C1 控制符 / DEL → \\xHH', () => {
    expect(escapeForDisplay('\x9b')).toBe('\\x9b');
    expect(escapeForDisplay('\x7f')).toBe('\\x7f');
  });
});

describe('labelToSymbols', () => {
  test('CTRL-C → ⌃C', () => {
    expect(labelToSymbols('CTRL-C')).toBe('⌃C');
  });
  test('SHIFT-Enter → ⇧⏎', () => {
    expect(labelToSymbols('SHIFT-Enter')).toBe('⇧⏎');
  });
  test('SHIFT-TAB → ⇧⇥', () => {
    expect(labelToSymbols('SHIFT-TAB')).toBe('⇧⇥');
  });
  test('Backspace → ⌫', () => {
    expect(labelToSymbols('Backspace')).toBe('⌫');
  });
  test('ESC → ⎋', () => {
    expect(labelToSymbols('ESC')).toBe('⎋');
  });
  test('方向键 ↑ 原样', () => {
    expect(labelToSymbols('↑')).toBe('↑');
  });
  test('F5 原样', () => {
    expect(labelToSymbols('F5')).toBe('F5');
  });
});
