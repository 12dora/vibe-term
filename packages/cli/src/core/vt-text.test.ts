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

describe('column arithmetic', () => {
  test('TAB advances to the next 8-column stop', () => {
    expect(stripAnsiText('ab\tc')).toBe('ab      c');
    expect(stripAnsiText('abcdefgh\tx')).toBe('abcdefgh        x');
  });

  test('CHA moves to an absolute column instead of acting as CR', () => {
    expect(stripAnsiText('abcdef\u001b[3GX')).toBe('abXdef');
    expect(stripAnsiText('abcdef\u001b[GX')).toBe('Xbcdef');
  });

  test('wide characters occupy two columns', () => {
    // 覆盖掉「你」的两列后第二个宽字符仍在原处（列 2-3），与真终端一致。
    expect(stripAnsiText('\u4f60\u597d\rxy')).toBe('xy\u597d');
    expect(stripAnsiText('\u4f60\u597d\rx')).toBe('x\u597d');
    expect(stripAnsiText('\u4f60\u597d\u001b[5GX')).toBe('\u4f60\u597dX');
  });

  test('combining marks stay on the previous cell', () => {
    expect(stripAnsiText('e\u0301\rx')).toBe('x');
  });
});

describe('trimScreenText', () => {
  test('keeps inner blank lines but drops the trailing ones', () => {
    expect(trimScreenText('a\n\nb  \n\n')).toBe('a\n\nb');
  });
});
