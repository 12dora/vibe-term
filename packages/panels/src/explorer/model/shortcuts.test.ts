import { describe, expect, test } from 'bun:test';
import {
  EXPLORER_SHORTCUTS,
  type ExplorerCommand,
  type ExplorerKeyEvent,
  type KeyChord,
  formatChord,
  isApplePlatform,
  isApplePlatformName,
  isEditableTarget,
  matchExplorerCommand,
} from './shortcuts';

function ev(key: string, patch: Partial<ExplorerKeyEvent> = {}): ExplorerKeyEvent {
  return {
    key,
    code: '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...patch,
  };
}

const ctrl = (key: string, patch: Partial<ExplorerKeyEvent> = {}) =>
  ev(key, { ctrlKey: true, ...patch });
const meta = (key: string, patch: Partial<ExplorerKeyEvent> = {}) =>
  ev(key, { metaKey: true, ...patch });
const alt = (code: string, key = 'Dead') => ev(key, { code, altKey: true });

const chordsOf = (command: ExplorerCommand): KeyChord[] =>
  EXPLORER_SHORTCUTS.find((item) => item.command === command)?.chords ?? [];

describe('EXPLORER_SHORTCUTS', () => {
  test('every command appears once with its label key', () => {
    const commands = EXPLORER_SHORTCUTS.map((item) => item.command);
    expect(new Set(commands).size).toBe(commands.length);
    for (const item of EXPLORER_SHORTCUTS) {
      expect(item.labelKey).toBe(`explorer.shortcuts.${item.command}`);
      expect(item.chords.length).toBeGreaterThan(0);
    }
  });

  test('never binds combinations the browser reserves', () => {
    const reserved = ['t', 'w', 'n', 'r', 'Tab'];
    for (const { chords } of EXPLORER_SHORTCUTS) {
      for (const chord of chords) {
        expect(chord.key).not.toBe('F5');
        if (chord.mod) expect(reserved).not.toContain(chord.key);
      }
    }
  });
});

describe('matchExplorerCommand', () => {
  test('plain keys', () => {
    expect(matchExplorerCommand(ev('Enter'), false)).toBe('open');
    expect(matchExplorerCommand(ev('Backspace'), false)).toBe('up');
    expect(matchExplorerCommand(ev('Escape'), false)).toBe('clearSelection');
    expect(matchExplorerCommand(ev('F2'), false)).toBe('rename');
    expect(matchExplorerCommand(ev('Delete'), false)).toBe('delete');
    expect(matchExplorerCommand(ev('/'), false)).toBe('focusFilter');
    expect(matchExplorerCommand(ev('x'), false)).toBeNull();
    expect(matchExplorerCommand(ev('ArrowDown'), false)).toBeNull();
  });

  test('mod chords use Ctrl off Apple platforms', () => {
    const table: Array<[string, ExplorerCommand]> = [
      ['ArrowDown', 'open'],
      ['o', 'open'],
      ['Enter', 'openInNewTab'],
      ['ArrowUp', 'up'],
      ['[', 'back'],
      [']', 'forward'],
      ['a', 'selectAll'],
      ['Backspace', 'delete'],
      ['c', 'copy'],
      ['x', 'cut'],
      ['v', 'paste'],
      ['f', 'focusFilter'],
      ['s', 'download'],
    ];
    for (const [key, command] of table) {
      expect(matchExplorerCommand(ctrl(key), false)).toBe(command);
      expect(matchExplorerCommand(meta(key), true)).toBe(command);
    }
  });

  test('the key comparison ignores case', () => {
    expect(matchExplorerCommand(ctrl('C'), false)).toBe('copy');
    expect(matchExplorerCommand(meta('A'), true)).toBe('selectAll');
    expect(matchExplorerCommand(ev('enter'), false)).toBe('open');
  });

  test('the other platform modifier must be up', () => {
    expect(matchExplorerCommand(meta('c'), false)).toBeNull();
    expect(matchExplorerCommand(ctrl('c'), true)).toBeNull();
    expect(matchExplorerCommand(ctrl('c', { metaKey: true }), false)).toBeNull();
    expect(matchExplorerCommand(meta('c', { ctrlKey: true }), true)).toBeNull();
    expect(matchExplorerCommand(ev('Enter', { metaKey: true }), false)).toBeNull();
    expect(matchExplorerCommand(ev('Enter', { ctrlKey: true }), true)).toBeNull();
  });

  test('modifiers outside the chord must be up', () => {
    expect(matchExplorerCommand(ctrl('c', { shiftKey: true }), false)).toBeNull();
    expect(matchExplorerCommand(ctrl('c', { altKey: true, code: 'KeyC' }), false)).toBeNull();
    expect(matchExplorerCommand(ev('Enter', { shiftKey: true }), false)).toBeNull();
    expect(matchExplorerCommand(ev('Delete', { altKey: true, code: 'Delete' }), false)).toBeNull();
    expect(matchExplorerCommand(ev('c'), false)).toBeNull();
  });

  test('alt chords match on the physical key', () => {
    const table: Array<[string, ExplorerCommand]> = [
      ['KeyN', 'newFolder'],
      ['KeyT', 'newTab'],
      ['KeyW', 'closeTab'],
      ['Backslash', 'split'],
      ['ArrowUp', 'up'],
      ['ArrowLeft', 'back'],
      ['ArrowRight', 'forward'],
    ];
    for (const [code, command] of table) {
      // macOS 上 ⌥N 的 key 是 ˜ 之类的死键，只有 code 可靠
      expect(matchExplorerCommand(alt(code), true)).toBe(command);
      expect(matchExplorerCommand(alt(code), false)).toBe(command);
    }
  });

  test('alt chords reject extra modifiers and a mismatched code', () => {
    expect(matchExplorerCommand(ev('n', { code: 'KeyN' }), false)).toBeNull();
    expect(matchExplorerCommand(ev('n', { code: 'KeyM', altKey: true }), false)).toBeNull();
    expect(
      matchExplorerCommand(ev('n', { code: 'KeyN', altKey: true, ctrlKey: true }), false)
    ).toBeNull();
    expect(
      matchExplorerCommand(ev('n', { code: 'KeyN', altKey: true, metaKey: true }), true)
    ).toBeNull();
    expect(
      matchExplorerCommand(ev('n', { code: 'KeyN', altKey: true, shiftKey: true }), false)
    ).toBeNull();
    expect(matchExplorerCommand(alt('ArrowDown'), false)).toBeNull();
  });

  test('? works with or without shift, / and ? never with mod or alt', () => {
    expect(matchExplorerCommand(ev('?', { shiftKey: true }), false)).toBe('showShortcuts');
    expect(matchExplorerCommand(ev('?'), true)).toBe('showShortcuts');
    expect(matchExplorerCommand(ev('/', { shiftKey: true }), false)).toBeNull();
    expect(matchExplorerCommand(ctrl('/'), false)).toBeNull();
    expect(matchExplorerCommand(meta('/'), true)).toBeNull();
    expect(matchExplorerCommand(ev('/', { altKey: true, code: 'Slash' }), false)).toBeNull();
    expect(matchExplorerCommand(ctrl('?', { shiftKey: true }), false)).toBeNull();
    expect(matchExplorerCommand(meta('?', { shiftKey: true }), true)).toBeNull();
    expect(
      matchExplorerCommand(ev('?', { altKey: true, shiftKey: true, code: 'Slash' }), false)
    ).toBeNull();
  });
});

describe('formatChord', () => {
  test('Apple platforms use symbols without separators', () => {
    expect(formatChord({ key: 'c', mod: true }, true)).toBe('⌘C');
    expect(formatChord({ key: 'n', alt: true }, true)).toBe('⌥N');
    expect(formatChord({ key: 'n', mod: true, shift: true }, true)).toBe('⇧⌘N');
    expect(formatChord({ key: 'n', mod: true, shift: true, alt: true }, true)).toBe('⌥⇧⌘N');
    expect(formatChord({ key: 'Backspace', mod: true }, true)).toBe('⌘⌫');
    expect(formatChord({ key: 'ArrowUp', mod: true }, true)).toBe('⌘↑');
    expect(formatChord({ key: 'Enter' }, true)).toBe('↩');
    expect(formatChord({ key: 'Backspace' }, true)).toBe('⌫');
    expect(formatChord({ key: 'Delete' }, true)).toBe('⌦');
    expect(formatChord({ key: 'Escape' }, true)).toBe('⎋');
    expect(formatChord({ key: 'F2' }, true)).toBe('F2');
    expect(formatChord({ key: '\\', alt: true }, true)).toBe('⌥\\');
  });

  test('other platforms spell the modifiers out', () => {
    expect(formatChord({ key: 'c', mod: true }, false)).toBe('Ctrl+C');
    expect(formatChord({ key: 'n', alt: true }, false)).toBe('Alt+N');
    expect(formatChord({ key: 'n', mod: true, shift: true, alt: true }, false)).toBe(
      'Ctrl+Alt+Shift+N'
    );
    expect(formatChord({ key: 'Enter' }, false)).toBe('Enter');
    expect(formatChord({ key: 'Backspace' }, false)).toBe('Backspace');
    expect(formatChord({ key: 'Backspace', mod: true }, false)).toBe('Ctrl+Backspace');
    expect(formatChord({ key: 'Delete' }, false)).toBe('Delete');
    expect(formatChord({ key: 'ArrowUp', alt: true }, false)).toBe('Alt+↑');
    expect(formatChord({ key: 'ArrowLeft', alt: true }, false)).toBe('Alt+←');
    expect(formatChord({ key: 'Escape' }, false)).toBe('Esc');
    expect(formatChord({ key: 'F2' }, false)).toBe('F2');
    expect(formatChord({ key: '?' }, false)).toBe('?');
    expect(formatChord({ key: '[', mod: true }, false)).toBe('Ctrl+[');
  });

  test('formats every chord in the table', () => {
    expect(chordsOf('open').map((chord) => formatChord(chord, true))).toEqual(['↩', '⌘↓', '⌘O']);
    expect(chordsOf('up').map((chord) => formatChord(chord, false))).toEqual([
      'Backspace',
      'Alt+↑',
      'Ctrl+↑',
    ]);
  });
});

describe('isApplePlatform', () => {
  test('recognises Apple platform names', () => {
    expect(isApplePlatformName('MacIntel')).toBe(true);
    expect(isApplePlatformName('macOS')).toBe(true);
    expect(isApplePlatformName('iPhone')).toBe(true);
    expect(isApplePlatformName('iPad')).toBe(true);
    expect(isApplePlatformName('Win32')).toBe(false);
    expect(isApplePlatformName('Linux x86_64')).toBe(false);
    expect(isApplePlatformName('')).toBe(false);
  });

  test('never throws, whatever the environment', () => {
    expect(typeof isApplePlatform()).toBe('boolean');
  });
});

describe('isEditableTarget', () => {
  const target = (value: unknown) => value as EventTarget;

  test('form controls and contentEditable hosts', () => {
    expect(isEditableTarget(target({ tagName: 'INPUT' }))).toBe(true);
    expect(isEditableTarget(target({ tagName: 'textarea' }))).toBe(true);
    expect(isEditableTarget(target({ tagName: 'SELECT' }))).toBe(true);
    expect(isEditableTarget(target({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
  });

  test('everything else', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(target({ tagName: 'DIV', isContentEditable: false }))).toBe(false);
    expect(isEditableTarget(target({ tagName: 'BUTTON' }))).toBe(false);
    expect(isEditableTarget(target({}))).toBe(false);
  });
});
