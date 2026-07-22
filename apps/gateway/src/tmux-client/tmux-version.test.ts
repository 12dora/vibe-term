import { describe, expect, test } from 'bun:test';

import {
  isControlModeSupported,
  normalizeTmuxVersionOutput,
  parseTmuxVersion,
  tmuxClientMatchesServer,
  tmuxVersionIdentity,
} from './tmux-version';

describe('parseTmuxVersion', () => {
  test('parses release versions', () => {
    expect(parseTmuxVersion('tmux 3.4')).toEqual({ major: 3, minor: 4 });
    expect(parseTmuxVersion('tmux 3.3a')).toEqual({ major: 3, minor: 3 });
    expect(parseTmuxVersion('tmux 2.9a')).toEqual({ major: 2, minor: 9 });
  });

  test('parses next/dev versions', () => {
    expect(parseTmuxVersion('tmux next-3.6')).toEqual({ major: 3, minor: 6 });
  });

  test('parses only the tmux-compatible first line from psmux output', () => {
    const output = 'tmux 3.3.7\r\npsmux 3.3.7 (05cc5d4 2026-07-20)\r\n';
    expect(normalizeTmuxVersionOutput(output)).toEqual({
      versionLine: 'tmux 3.3.7',
      provenance: 'psmux 3.3.7 (05cc5d4 2026-07-20)',
    });
    expect(parseTmuxVersion(output)).toEqual({ major: 3, minor: 3 });
    expect(tmuxVersionIdentity(output)).toBe('3.3.7');
  });

  test('returns null for unversioned builds', () => {
    expect(parseTmuxVersion('tmux master')).toBeNull();
    expect(parseTmuxVersion('')).toBeNull();
  });
});

describe('isControlModeSupported', () => {
  test('accepts >= 3.0 and unknown versions', () => {
    expect(isControlModeSupported({ major: 3, minor: 0 })).toBe(true);
    expect(isControlModeSupported({ major: 3, minor: 4 })).toBe(true);
    expect(isControlModeSupported({ major: 4, minor: 0 })).toBe(true);
    expect(isControlModeSupported(null)).toBe(true);
  });

  test('rejects < 3.0', () => {
    expect(isControlModeSupported({ major: 2, minor: 9 })).toBe(false);
    expect(isControlModeSupported({ major: 1, minor: 8 })).toBe(false);
  });
});

describe('tmuxClientMatchesServer', () => {
  test('accepts the exact client/server release', () => {
    expect(tmuxClientMatchesServer('tmux 3.7b', '3.7b')).toBe(true);
    expect(tmuxClientMatchesServer('tmux master', 'master')).toBe(true);
  });

  test('rejects a bundled client against a different existing server', () => {
    expect(tmuxClientMatchesServer('tmux 3.5a', '3.7b')).toBe(false);
    expect(tmuxClientMatchesServer('tmux 3.7b', '3.7a')).toBe(false);
  });

  test('ignores psmux provenance when comparing client and server identities', () => {
    expect(
      tmuxClientMatchesServer('tmux 3.3.7\r\npsmux 3.3.7 (05cc5d4 2026-07-20)\r\n', '3.3.7\r\n')
    ).toBe(true);
  });
});
