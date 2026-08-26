import { describe, expect, test } from 'bun:test';
import {
  dataTransferHasFiles,
  fileErrorKey,
  nodeBasename,
  parentOf,
  planUpload,
  relativeToRoot,
  resolveRsyncInstallDeviceId,
  rsyncMissingSide,
  staleChildExpansionPaths,
} from './file-tree-logic';

describe('parentOf', () => {
  test('returns the containing directory', () => {
    expect(parentOf('/home/me/notes.txt')).toBe('/home/me');
    expect(parentOf('/home')).toBe('/');
  });

  test('the filesystem root is its own parent', () => {
    expect(parentOf('/')).toBe('/');
  });
});

describe('nodeBasename', () => {
  test('takes the last segment', () => {
    expect(nodeBasename('/home/me/notes.txt')).toBe('notes.txt');
    expect(nodeBasename('notes.txt')).toBe('notes.txt');
  });

  test('falls back to the whole path when it ends in a slash', () => {
    expect(nodeBasename('/')).toBe('/');
  });
});

describe('relativeToRoot', () => {
  test('strips the root prefix', () => {
    expect(relativeToRoot('/home/me', '/home/me/src/a.ts')).toBe('src/a.ts');
    expect(relativeToRoot('/', '/etc/hosts')).toBe('etc/hosts');
  });

  test('the root itself is "."', () => {
    expect(relativeToRoot('/home/me', '/home/me')).toBe('.');
    expect(relativeToRoot('/', '/')).toBe('.');
  });

  test('a path outside the root is left untouched', () => {
    expect(relativeToRoot('/home/me', '/var/log')).toBe('/var/log');
    // 前缀相同但不是子路径（/home/meeting）不应被剥离
    expect(relativeToRoot('/home/me', '/home/meeting')).toBe('/home/meeting');
  });
});

describe('fileErrorKey', () => {
  test('maps a code onto its i18n key, unknown by default', () => {
    expect(fileErrorKey('rsync_missing_local')).toBe('files.error.rsync_missing_local');
    expect(fileErrorKey(undefined)).toBe('files.error.unknown');
  });
});

describe('dataTransferHasFiles', () => {
  test('detects OS file drags for both array and DOMStringList shapes', () => {
    expect(dataTransferHasFiles(['Files'])).toBe(true);
    expect(dataTransferHasFiles({ length: 2, 0: 'text/plain', 1: 'Files' })).toBe(true);
    expect(dataTransferHasFiles(['text/plain'])).toBe(false);
    expect(dataTransferHasFiles([])).toBe(false);
  });
});

describe('rsyncMissingSide', () => {
  test('recognises both rsync error codes', () => {
    expect(rsyncMissingSide('rsync_missing_remote')).toBe('remote');
    expect(rsyncMissingSide('rsync_missing_local')).toBe('local');
  });

  test('other errors are not rsync failures', () => {
    expect(rsyncMissingSide('not_found')).toBeNull();
    expect(rsyncMissingSide(undefined)).toBeNull();
  });
});

describe('resolveRsyncInstallDeviceId', () => {
  const sshRoot = { deviceId: 'dev-ssh', deviceType: 'ssh' as const };
  const localRoot = { deviceId: 'dev-local', deviceType: 'local' as const };

  test('remote side installs on the root device', () => {
    expect(resolveRsyncInstallDeviceId(sshRoot, 'remote', 'dev-local')).toBe('dev-ssh');
  });

  test('local side installs on the local device', () => {
    expect(resolveRsyncInstallDeviceId(localRoot, 'local', null)).toBe('dev-local');
    expect(resolveRsyncInstallDeviceId(sshRoot, 'local', 'dev-local')).toBe('dev-local');
  });

  test('no local device means nowhere to install', () => {
    expect(resolveRsyncInstallDeviceId(sshRoot, 'local', null)).toBeNull();
  });
});

describe('staleChildExpansionPaths', () => {
  const key = (rootId: string, path: string) => `${rootId}\n${path}`;

  test('collapses direct children that disappeared from the listing', () => {
    const keys = [key('r1', '/a'), key('r1', '/a/gone'), key('r1', '/a/kept')];
    expect(staleChildExpansionPaths(keys, 'r1', '/a', new Set(['/a/kept']))).toEqual(['/a/gone']);
  });

  test('never collapses the node itself, including the filesystem root', () => {
    const keys = [key('r1', '/'), key('r1', '/tmp')];
    expect(staleChildExpansionPaths(keys, 'r1', '/', new Set(['/tmp']))).toEqual([]);
    expect(staleChildExpansionPaths([key('r1', '/')], 'r1', '/', new Set())).toEqual([]);
  });

  test('ignores grandchildren and other roots', () => {
    const keys = [key('r1', '/a/x/deep'), key('r2', '/a/gone')];
    expect(staleChildExpansionPaths(keys, 'r1', '/a', new Set())).toEqual([]);
  });
});

describe('planUpload', () => {
  const file = (name: string, size: number) => ({ name, size });

  test('splits files by the transfer limit', () => {
    const files = [file('small', 10), file('huge', 5000), file('exact', 100)];
    expect(planUpload(files, 100)).toEqual({
      accepted: [file('small', 10), file('exact', 100)],
      oversized: [file('huge', 5000)],
    });
  });

  test('an empty selection yields empty buckets', () => {
    expect(planUpload([], 100)).toEqual({ accepted: [], oversized: [] });
  });
});
