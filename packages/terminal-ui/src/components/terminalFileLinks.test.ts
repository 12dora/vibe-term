import { describe, expect, test } from 'bun:test';
import type { TmuxSession } from '@tmex/shared';
import { findPaneCurrentPath, resolveFileLinkRoot } from './terminalFileLinks';

const roots = [
  { id: 'home', path: '/Users/dev' },
  { id: 'project', path: '/Users/dev/code' },
  { id: 'other', path: '/srv' },
];

describe('resolveFileLinkRoot', () => {
  test('picks the longest matching root', () => {
    expect(resolveFileLinkRoot(roots, '/Users/dev/code/src/main.ts')?.id).toBe('project');
    expect(resolveFileLinkRoot(roots, '/Users/dev/notes.md')?.id).toBe('home');
  });

  test('matches the root path itself', () => {
    expect(resolveFileLinkRoot(roots, '/srv')?.id).toBe('other');
  });

  test('requires a path separator boundary', () => {
    expect(resolveFileLinkRoot(roots, '/Users/developer/x')).toBeNull();
    expect(resolveFileLinkRoot(roots, '/Users/dev/codex/x')?.id).toBe('home');
  });

  test('treats the filesystem root as covering everything', () => {
    expect(resolveFileLinkRoot([{ id: 'fs', path: '/' }], '/etc/hosts')?.id).toBe('fs');
  });

  test('returns null when nothing matches and never mutates the input', () => {
    const input = [...roots];
    expect(resolveFileLinkRoot(input, '/var/log/system.log')).toBeNull();
    expect(input.map((root) => root.id)).toEqual(['home', 'project', 'other']);
  });
});

describe('findPaneCurrentPath', () => {
  const session: TmuxSession = {
    id: '$0',
    name: 'main',
    windows: [
      {
        id: '@0',
        name: 'one',
        index: 0,
        active: false,
        panes: [{ id: '%0', windowId: '@0', index: 0, active: false, width: 80, height: 24 }],
      },
      {
        id: '@1',
        name: 'two',
        index: 1,
        active: true,
        panes: [
          {
            id: '%1',
            windowId: '@1',
            index: 0,
            active: true,
            width: 80,
            height: 24,
            currentPath: '/Users/dev/code',
          },
        ],
      },
    ],
  };

  test('finds the pane across windows', () => {
    expect(findPaneCurrentPath(session, '%1')).toBe('/Users/dev/code');
  });

  test('returns undefined for a pane without a path, an unknown pane or no session', () => {
    expect(findPaneCurrentPath(session, '%0')).toBeUndefined();
    expect(findPaneCurrentPath(session, '%9')).toBeUndefined();
    expect(findPaneCurrentPath(null, '%1')).toBeUndefined();
    expect(findPaneCurrentPath(undefined, '%1')).toBeUndefined();
  });
});
