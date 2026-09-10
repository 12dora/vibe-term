import { describe, expect, test } from 'bun:test';
import { UsageError } from './errors';
import { controlByte, hexToSequence, keyNameToSequence, keysToSequence } from './term-keys';

const ESC = '\u001b';

describe('keyNameToSequence', () => {
  test('named keys use the xterm sequences', () => {
    expect(keyNameToSequence('Enter')).toBe('\r');
    expect(keyNameToSequence('escape')).toBe(ESC);
    expect(keyNameToSequence('Tab')).toBe('\t');
    expect(keyNameToSequence('BSpace')).toBe('\u007f');
    expect(keyNameToSequence('Up')).toBe(`${ESC}[A`);
    expect(keyNameToSequence('PageDown')).toBe(`${ESC}[6~`);
    expect(keyNameToSequence('F1')).toBe(`${ESC}OP`);
    expect(keyNameToSequence('F5')).toBe(`${ESC}[15~`);
  });

  test('control keys become C0 bytes', () => {
    expect(keyNameToSequence('C-c')).toBe('\u0003');
    expect(keyNameToSequence('C-a')).toBe('\u0001');
    expect(keyNameToSequence('C-Space')).toBe('\u0000');
    expect(controlByte('?')).toBe('\u007f');
    expect(controlByte('1')).toBeNull();
  });

  test('meta prefixes ESC and shift upcases letters', () => {
    expect(keyNameToSequence('M-x')).toBe(`${ESC}x`);
    expect(keyNameToSequence('S-a')).toBe('A');
    expect(keyNameToSequence('M-C-c')).toBe(`${ESC}\u0003`);
  });

  test('modified special keys use the CSI modifier parameter', () => {
    expect(keyNameToSequence('S-Up')).toBe(`${ESC}[1;2A`);
    expect(keyNameToSequence('C-Right')).toBe(`${ESC}[1;5C`);
    expect(keyNameToSequence('C-F1')).toBe(`${ESC}[1;5P`);
    expect(keyNameToSequence('S-Delete')).toBe(`${ESC}[3;2~`);
  });

  test('unknown words are not keys', () => {
    expect(keyNameToSequence('hello')).toBeNull();
    expect(keyNameToSequence('')).toBeNull();
  });

  test('a control form that does not exist is a usage error', () => {
    expect(() => keyNameToSequence('C-é')).toThrow(UsageError);
  });
});

describe('keysToSequence', () => {
  test('mixes literal words and key names without inserting spaces', () => {
    expect(keysToSequence(['echo', ' hi', 'Enter'])).toBe('echo hi\r');
  });

  test('--literal joins the words with spaces and never looks up names', () => {
    expect(keysToSequence(['echo', 'Enter'], { literal: true })).toBe('echo Enter');
  });
});

describe('hexToSequence', () => {
  test('accepts separators and decodes UTF-8', () => {
    expect(hexToSequence('1b 5b 41')).toBe(`${ESC}[A`);
    expect(hexToSequence('e4:bd:a0')).toBe('你');
  });

  test('rejects odd input and invalid UTF-8', () => {
    expect(() => hexToSequence('1b5')).toThrow(UsageError);
    expect(() => hexToSequence('zz')).toThrow(UsageError);
    expect(() => hexToSequence('ff')).toThrow(UsageError);
  });

  test('an explicitly encoded replacement character is allowed through', () => {
    expect(hexToSequence('efbfbd')).toBe('�');
  });
});
