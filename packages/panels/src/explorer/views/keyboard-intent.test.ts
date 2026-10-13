import { describe, expect, test } from 'bun:test';
import type { ExplorerKeyEvent } from '../model/shortcuts';
import {
  type KeyboardLayout,
  gridColumnCount,
  keyboardIntent,
  typeAheadStep,
} from './keyboard-intent';

function key(key: string, init: Partial<ExplorerKeyEvent> = {}): ExplorerKeyEvent {
  return { key, code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init };
}

const LIST: KeyboardLayout = { grid: false, columns: 1, pageRows: 10, apple: false };
const GRID: KeyboardLayout = { grid: true, columns: 5, pageRows: 3, apple: false };

describe('keyboardIntent — list', () => {
  test('up / down move by one row, shift extends', () => {
    expect(keyboardIntent(key('ArrowDown'), LIST)).toEqual({ delta: 1, extend: false });
    expect(keyboardIntent(key('ArrowUp'), LIST)).toEqual({ delta: -1, extend: false });
    expect(keyboardIntent(key('ArrowDown', { shiftKey: true }), LIST)).toEqual({
      delta: 1,
      extend: true,
    });
  });

  test('left / right are not handled in the list', () => {
    expect(keyboardIntent(key('ArrowLeft'), LIST)).toBeNull();
    expect(keyboardIntent(key('ArrowRight'), LIST)).toBeNull();
  });

  test('a stale column count never leaks into the list', () => {
    expect(keyboardIntent(key('ArrowDown'), { ...LIST, columns: 7 })).toEqual({
      delta: 1,
      extend: false,
    });
  });

  test('home / end / page keys', () => {
    expect(keyboardIntent(key('Home'), LIST)).toEqual({
      delta: Number.NEGATIVE_INFINITY,
      extend: false,
    });
    expect(keyboardIntent(key('End', { shiftKey: true }), LIST)).toEqual({
      delta: Number.POSITIVE_INFINITY,
      extend: true,
    });
    expect(keyboardIntent(key('PageDown'), LIST)).toEqual({ delta: 10, extend: false });
    expect(keyboardIntent(key('PageUp'), LIST)).toEqual({ delta: -10, extend: false });
    expect(keyboardIntent(key('PageDown'), { ...LIST, pageRows: 0 })).toEqual({
      delta: 1,
      extend: false,
    });
  });
});

describe('keyboardIntent — grid', () => {
  test('all four arrows: horizontal ±1, vertical ±columns', () => {
    expect(keyboardIntent(key('ArrowLeft'), GRID)).toEqual({ delta: -1, extend: false });
    expect(keyboardIntent(key('ArrowRight'), GRID)).toEqual({ delta: 1, extend: false });
    expect(keyboardIntent(key('ArrowUp'), GRID)).toEqual({ delta: -5, extend: false });
    expect(keyboardIntent(key('ArrowDown', { shiftKey: true }), GRID)).toEqual({
      delta: 5,
      extend: true,
    });
  });

  test('a page is visible rows × columns', () => {
    expect(keyboardIntent(key('PageDown'), GRID)).toEqual({ delta: 15, extend: false });
    expect(keyboardIntent(key('PageUp'), GRID)).toEqual({ delta: -15, extend: false });
  });

  test('columns below 1 fall back to 1', () => {
    expect(keyboardIntent(key('ArrowDown'), { ...GRID, columns: 0 })).toEqual({
      delta: 1,
      extend: false,
    });
  });
});

describe('keyboardIntent — commands are left to the composition', () => {
  test.each([
    ['Enter', {}],
    ['Delete', {}],
    ['F2', {}],
    ['Backspace', {}],
    ['Escape', {}],
    ['/', {}],
    ['?', { shiftKey: true }],
    ['a', { ctrlKey: true }],
    ['c', { ctrlKey: true }],
    ['ArrowUp', { altKey: true }],
    ['ArrowDown', { ctrlKey: true }],
    ['ArrowLeft', { altKey: true }],
    ['n', { altKey: true, code: 'KeyN' }],
    ['Tab', {}],
    ['Shift', { shiftKey: true }],
  ] as Array<[string, Partial<ExplorerKeyEvent>]>)('%s → null', (name, init) => {
    expect(keyboardIntent(key(name, init), LIST)).toBeNull();
    expect(keyboardIntent(key(name, init), GRID)).toBeNull();
  });

  test('⌘ combinations on Apple platforms are ignored too', () => {
    const apple = { ...LIST, apple: true };
    expect(keyboardIntent(key('ArrowDown', { metaKey: true }), apple)).toBeNull();
    expect(keyboardIntent(key('a', { metaKey: true }), apple)).toBeNull();
  });
});

describe('keyboardIntent — type-ahead and toggle', () => {
  test('printable characters start type-ahead', () => {
    expect(keyboardIntent(key('a'), LIST)).toEqual({ typeAhead: 'a' });
    expect(keyboardIntent(key('R', { shiftKey: true }), LIST)).toEqual({ typeAhead: 'R' });
    expect(keyboardIntent(key('7'), GRID)).toEqual({ typeAhead: '7' });
    expect(keyboardIntent(key('文'), LIST)).toEqual({ typeAhead: '文' });
    expect(keyboardIntent(key(' '), LIST)).toEqual({ typeAhead: ' ' });
  });

  test('IME composition keys are not characters', () => {
    expect(keyboardIntent(key('Process'), LIST)).toBeNull();
    expect(keyboardIntent(key('Dead'), LIST)).toBeNull();
  });

  test('mod+Space toggles the focused item', () => {
    expect(keyboardIntent(key(' ', { ctrlKey: true }), LIST)).toEqual({ toggleFocus: true });
    expect(keyboardIntent(key(' ', { metaKey: true }), { ...GRID, apple: true })).toEqual({
      toggleFocus: true,
    });
    expect(keyboardIntent(key(' ', { ctrlKey: true, altKey: true }), LIST)).toBeNull();
  });
});

describe('typeAheadStep', () => {
  test('first letter searches from the item after the cursor', () => {
    expect(typeAheadStep('', 'a', 3)).toEqual({ buffer: 'a', prefix: 'a', fromIndex: 4 });
    expect(typeAheadStep('', 'a', -1)).toEqual({ buffer: 'a', prefix: 'a', fromIndex: 0 });
  });

  test('a repeated single letter keeps cycling with that one letter', () => {
    expect(typeAheadStep('a', 'a', 4)).toEqual({ buffer: 'aa', prefix: 'a', fromIndex: 5 });
    expect(typeAheadStep('aa', 'A', 9)).toEqual({ buffer: 'aaA', prefix: 'A', fromIndex: 10 });
  });

  test('a different letter switches to prefix matching from the cursor (inclusive)', () => {
    expect(typeAheadStep('a', 'b', 4)).toEqual({ buffer: 'ab', prefix: 'ab', fromIndex: 4 });
    expect(typeAheadStep('ab', 'c', -1)).toEqual({ buffer: 'abc', prefix: 'abc', fromIndex: 0 });
    expect(typeAheadStep('aa', 'b', 2)).toEqual({ buffer: 'aab', prefix: 'aab', fromIndex: 2 });
  });

  test('space only counts inside a running buffer', () => {
    expect(typeAheadStep('', ' ', 0)).toBeNull();
    expect(typeAheadStep('my', ' ', 1)).toEqual({ buffer: 'my ', prefix: 'my ', fromIndex: 1 });
  });
});

describe('gridColumnCount', () => {
  test('counts the tracks that fit', () => {
    // 3 列：3 × 104 + 2 × 4 = 320
    expect(gridColumnCount(320, 104, 4)).toBe(3);
    expect(gridColumnCount(323, 104, 4)).toBe(3);
    // 1fr 拉伸后的磁贴更宽，列数不变
    expect(gridColumnCount(400, 130.66, 4)).toBe(3);
    expect(gridColumnCount(100, 104, 4)).toBe(1);
  });

  test('degenerate measurements fall back to one column', () => {
    expect(gridColumnCount(0, 104, 4)).toBe(1);
    expect(gridColumnCount(320, 0, 4)).toBe(1);
    expect(gridColumnCount(Number.NaN, 104, 4)).toBe(1);
  });
});
