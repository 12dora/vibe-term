import { describe, expect, test } from 'bun:test';
import { UsageError } from './errors';
import {
  VIRTUAL_FS_ROOT_ID,
  isLocalPath,
  joinRootPath,
  parseRemoteFileRef,
  posixBasename,
  posixDirname,
  posixJoin,
} from './files-path';

const UUID = '11111111-1111-4111-8111-111111111111';
const NODE = 'a'.repeat(32);

describe('isLocalPath', () => {
  test('recognizes unix and home paths', () => {
    expect(isLocalPath('/tmp/a')).toBe(true);
    expect(isLocalPath('./a')).toBe(true);
    expect(isLocalPath('../a')).toBe(true);
    expect(isLocalPath('~/.ssh')).toBe(true);
    expect(isLocalPath('.')).toBe(true);
    expect(isLocalPath('C:\\Windows')).toBe(true);
  });

  test('remote specs are not local', () => {
    expect(isLocalPath('office:home/docs')).toBe(false);
    expect(isLocalPath('home/docs')).toBe(false);
    expect(isLocalPath(`${UUID}:src/a.ts`)).toBe(false);
  });
});

describe('parseRemoteFileRef', () => {
  test('node + root name + relative path', () => {
    expect(parseRemoteFileRef('office:home/docs/a.txt')).toEqual({
      node: 'office',
      root: 'home',
      relpath: 'docs/a.txt',
    });
  });

  test('root name only uses --node later', () => {
    expect(parseRemoteFileRef('home/docs')).toEqual({ node: null, root: 'home', relpath: 'docs' });
  });

  test('root id colon form keeps an absolute relpath', () => {
    expect(parseRemoteFileRef(`${UUID}:/home/me/a.ts`)).toEqual({
      node: null,
      root: UUID,
      relpath: '/home/me/a.ts',
    });
  });

  test('node id + root id', () => {
    expect(parseRemoteFileRef(`${NODE}:${UUID}:src`)).toEqual({
      node: NODE,
      root: UUID,
      relpath: 'src',
    });
  });

  test('fs-root virtual id', () => {
    expect(parseRemoteFileRef(`${VIRTUAL_FS_ROOT_ID}:/etc`)).toEqual({
      node: null,
      root: VIRTUAL_FS_ROOT_ID,
      relpath: '/etc',
    });
  });

  test('rejects empty and local paths', () => {
    expect(() => parseRemoteFileRef('')).toThrow(UsageError);
    expect(() => parseRemoteFileRef('/tmp/a')).toThrow(UsageError);
  });
});

describe('joinRootPath', () => {
  test('joins relative and keeps absolute', () => {
    expect(joinRootPath('/home/me', 'docs/a')).toBe('/home/me/docs/a');
    expect(joinRootPath('/home/me', '/home/me/docs')).toBe('/home/me/docs');
    expect(joinRootPath('/home/me', '')).toBe('/home/me');
    expect(joinRootPath('/', 'etc')).toBe('/etc');
  });

  test('basename and dirname', () => {
    expect(posixBasename('/home/me/a.txt')).toBe('a.txt');
    expect(posixDirname('/home/me/a.txt')).toBe('/home/me');
    expect(posixJoin('/home/me', 'docs')).toBe('/home/me/docs');
  });
});
