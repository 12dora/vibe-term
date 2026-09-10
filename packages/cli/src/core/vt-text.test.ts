import { describe, expect, test } from 'bun:test';
import { stripAnsiText, trimScreenText } from './vt-text';

describe('stripAnsiText', () => {
  test('drops SGR and keeps the text', () => {
    expect(stripAnsiText('\u001b[1m\u001b[31mred\u001b[0m plain')).toBe('red plain');
  });

  test('drops OSC sequences terminated by BEL or ST', () => {
    expect(stripAnsiText('\u001b]0;title\u0007body')).toBe('body');
    expect(stripAnsiText('\u001b]52;c;Zm9v\u001b\\after')).toBe('after');
  });

  test('a bare LF starts a new line at column 0', () => {
    expect(stripAnsiText('one\ntwo')).toBe('one\ntwo');
  });

  test('CR rewrites the current line instead of starting a new one', () => {
    expect(stripAnsiText('50%\r100%')).toBe('100%');
  });

  test('backspace and erase-line reproduce shell line editing', () => {
    expect(stripAnsiText('e\becho hi')).toBe('echo hi');
    expect(stripAnsiText('abcdef\r\u001b[Kxy')).toBe('xy');
  });

  test('erase-display throws away everything collected so far', () => {
    expect(stripAnsiText('junk\n\u001b[2Jscreen')).toBe('screen');
  });

  test('astral characters keep one column', () => {
    expect(stripAnsiText('a🙂b')).toBe('a🙂b');
  });

  test('cursor addressing is ignored, not executed', () => {
    expect(stripAnsiText('\u001b[10;5Htext')).toBe('text');
  });

  test('trailing blanks and blank lines are trimmed by default', () => {
    expect(stripAnsiText('line   \n\n\n')).toBe('line');
    expect(stripAnsiText('line   \n', { trimLines: false })).toBe('line   \n');
  });
});

describe('trimScreenText', () => {
  test('keeps inner blank lines but drops the trailing ones', () => {
    expect(trimScreenText('a\n\nb  \n\n')).toBe('a\n\nb');
  });
});
