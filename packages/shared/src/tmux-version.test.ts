import { describe, expect, test } from 'bun:test';
import { MIN_TMUX_VERSION, compareTmuxVersion, parseTmuxVersion } from './tmux-version';

describe('parseTmuxVersion', () => {
  test('parses release versions', () => {
    expect(parseTmuxVersion('tmux 3.4')).toEqual({ major: 3, minor: 4 });
    expect(parseTmuxVersion('tmux 3.3a')).toEqual({ major: 3, minor: 3 });
    expect(parseTmuxVersion('tmux 2.9a')).toEqual({ major: 2, minor: 9 });
  });

  test('parses next/dev versions', () => {
    expect(parseTmuxVersion('tmux next-3.6')).toEqual({ major: 3, minor: 6 });
  });

  test('parses only the first non-empty version line', () => {
    const output = 'tmux 3.3.7\r\npsmux 3.3.7 (05cc5d4 2026-07-20)\r\n';
    expect(parseTmuxVersion(output)).toEqual({ major: 3, minor: 3 });
  });

  test('ignores numeric provenance when the version line is non-numeric', () => {
    expect(parseTmuxVersion('tmux master\npsmux 3.3.7 (05cc5d4 2026-07-20)\n')).toBeNull();
  });

  test('returns null for unversioned builds', () => {
    expect(parseTmuxVersion('tmux master')).toBeNull();
    expect(parseTmuxVersion('tmux openbsd')).toBeNull();
    expect(parseTmuxVersion('')).toBeNull();
  });

  test('parses version with extra whitespace', () => {
    expect(parseTmuxVersion('  tmux 3.4  ')).toEqual({ major: 3, minor: 4 });
  });
});

describe('compareTmuxVersion', () => {
  test('accepts >= minimum and unknown versions', () => {
    expect(compareTmuxVersion({ major: 3, minor: 0 }, MIN_TMUX_VERSION)).toBe(true);
    expect(compareTmuxVersion({ major: 3, minor: 4 }, MIN_TMUX_VERSION)).toBe(true);
    expect(compareTmuxVersion({ major: 4, minor: 0 }, MIN_TMUX_VERSION)).toBe(true);
    expect(compareTmuxVersion(null, MIN_TMUX_VERSION)).toBe(true);
  });

  test('rejects < minimum', () => {
    expect(compareTmuxVersion({ major: 2, minor: 9 }, MIN_TMUX_VERSION)).toBe(false);
    expect(compareTmuxVersion({ major: 1, minor: 8 }, MIN_TMUX_VERSION)).toBe(false);
  });
});
