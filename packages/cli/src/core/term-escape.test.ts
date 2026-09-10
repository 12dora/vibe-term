import { describe, expect, test } from 'bun:test';
import { UsageError } from './errors';
import {
  DetachEscapeMatcher,
  type EscapeAction,
  escapeHelpLines,
  parseDetachKey,
} from './term-escape';

function feed(input: string, spec = '~.'): EscapeAction[] {
  const matcher = new DetachEscapeMatcher(parseDetachKey(spec));
  return matcher.push(input);
}

describe('parseDetachKey', () => {
  test('defaults to ~. and accepts a custom pair', () => {
    expect(parseDetachKey(undefined)).toEqual({ escapeChar: '~', detachChar: '.' });
    expect(parseDetachKey('^q')).toEqual({ escapeChar: '^', detachChar: 'q' });
  });

  test('none disables the escape machinery', () => {
    expect(parseDetachKey('none')).toEqual({ escapeChar: '', detachChar: '' });
    expect(escapeHelpLines(parseDetachKey('none'))[0]).toContain('disabled');
  });

  test('anything but two characters is a usage error', () => {
    expect(() => parseDetachKey('~')).toThrow(UsageError);
    expect(() => parseDetachKey('~.x')).toThrow(UsageError);
  });
});

describe('DetachEscapeMatcher', () => {
  test('plain input is forwarded as one send', () => {
    expect(feed('ls -l\r')).toEqual([{ type: 'send', data: 'ls -l\r' }]);
  });

  test('~. at the start of a line detaches', () => {
    expect(feed('~.')).toEqual([{ type: 'detach' }]);
    expect(feed('ls\r~.')).toEqual([{ type: 'send', data: 'ls\r' }, { type: 'detach' }]);
  });

  test('~ in the middle of a line is just a tilde', () => {
    expect(feed('cd ~/src\r')).toEqual([{ type: 'send', data: 'cd ~/src\r' }]);
  });

  test('~~ sends one literal tilde and leaves the escape state', () => {
    expect(feed('~~.')).toEqual([{ type: 'send', data: '~.' }]);
  });

  test('~w lists windows and ~? helps', () => {
    expect(feed('~w')).toEqual([{ type: 'windows' }]);
    expect(feed('~?')).toEqual([{ type: 'help' }]);
  });

  test('~<n>~ and ~<n><Enter> switch window, multi-digit included', () => {
    expect(feed('~3~')).toEqual([{ type: 'select-window', index: 3 }]);
    expect(feed('~12~')).toEqual([{ type: 'select-window', index: 12 }]);
    expect(feed('~7\r')).toEqual([{ type: 'select-window', index: 7 }]);
  });

  test('a bare ~<n> lands on the next key, which is still sent', () => {
    expect(feed('~1x')).toEqual([
      { type: 'select-window', index: 1 },
      { type: 'send', data: 'x' },
    ]);
    const matcher = new DetachEscapeMatcher(parseDetachKey('~.'));
    expect(matcher.push('~2')).toEqual([]);
    expect(matcher.push('~')).toEqual([{ type: 'select-window', index: 2 }]);
  });

  test('an unknown escape sends the tilde and the character', () => {
    expect(feed('~q')).toEqual([{ type: 'send', data: '~q' }]);
  });

  test('the escape may straddle two reads', () => {
    const matcher = new DetachEscapeMatcher(parseDetachKey('~.'));
    expect(matcher.push('~')).toEqual([]);
    expect(matcher.push('.')).toEqual([{ type: 'detach' }]);
  });

  test('after a literal tilde the line is no longer at its start', () => {
    const matcher = new DetachEscapeMatcher(parseDetachKey('~.'));
    expect(matcher.push('~~~.')).toEqual([{ type: 'send', data: '~~.' }]);
  });

  test('disabled escapes forward everything untouched', () => {
    expect(feed('~.', 'none')).toEqual([{ type: 'send', data: '~.' }]);
  });
});
