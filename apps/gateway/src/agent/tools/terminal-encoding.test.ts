import { describe, expect, test } from 'bun:test';
import {
  KEY_SEQUENCES,
  SEND_INPUT_KEYS,
  encodeCombo,
  encodeKeysToSequence,
} from './terminal-encoding';

describe('terminal encoding - keys', () => {
  test('所有 key 枚举均有映射且为预期字节序列', () => {
    expect(Object.keys(KEY_SEQUENCES).sort()).toEqual([...SEND_INPUT_KEYS].sort());
    expect(KEY_SEQUENCES.enter).toBe('\r');
    expect(KEY_SEQUENCES.ctrl_c).toBe('\x03');
  });

  test('encodeKeysToSequence 按顺序拼接', () => {
    expect(encodeKeysToSequence(['ctrl_c', 'enter'])).toBe('\x03\r');
    expect(encodeKeysToSequence([])).toBe('');
  });
});

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
