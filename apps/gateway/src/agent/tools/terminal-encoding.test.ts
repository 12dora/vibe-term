import { describe, expect, test } from 'bun:test';
import { encodeCombo } from './terminal-encoding';

describe('terminal encoding - combos', () => {
  test('Ctrl+字母编码为 control code', () => {
    expect(encodeCombo({ modifiers: ['ctrl'], key: 'c' })).toBe('\x03');
    expect(encodeCombo({ modifiers: ['ctrl'], key: 'd' })).toBe('\x04');
  });

  test('Alt/Meta 给特殊键加 ESC 前缀', () => {
    expect(encodeCombo({ modifiers: ['alt'], key: 'enter' })).toBe('\x1b\r');
    expect(encodeCombo({ modifiers: ['meta'], key: 'up' })).toBe('\x1b\x1b[A');
  });

  test('Shift+字母转大写；无 modifier 的特殊键走转义序列', () => {
    expect(encodeCombo({ modifiers: ['shift'], key: 'a' })).toBe('A');
    expect(encodeCombo({ key: 'up' })).toBe('\x1b[A');
    expect(encodeCombo({ key: 'f1' })).toBe('\x1bOP');
  });
});
