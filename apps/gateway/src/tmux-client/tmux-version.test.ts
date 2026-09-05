import { describe, expect, test } from 'bun:test';

import {
  normalizeTmuxVersionOutput,
  parseTmuxVersion,
  tmuxClientMatchesServer,
  tmuxVersionIdentity,
} from './tmux-version';

describe('parseTmuxVersion', () => {
  test('parses only the tmux-compatible first line from psmux output', () => {
    const output = 'tmux 3.3.7\r\npsmux 3.3.7 (05cc5d4 2026-07-20)\r\n';
    expect(normalizeTmuxVersionOutput(output)).toEqual({
      versionLine: 'tmux 3.3.7',
      provenance: 'psmux 3.3.7 (05cc5d4 2026-07-20)',
    });
    expect(parseTmuxVersion(output)).toEqual({ major: 3, minor: 3 });
    expect(tmuxVersionIdentity(output)).toBe('3.3.7');
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
