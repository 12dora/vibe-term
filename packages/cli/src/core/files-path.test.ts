import { describe, expect, test } from 'bun:test';
import { UsageError } from './errors';
import {
  VIRTUAL_FS_ROOT_ID,
  VIRTUAL_HOME_ROOT_ID,
  isLocalPath,
  isPathInside,
  isRemoteSpec,
  joinRootPath,
  normalizePosixPath,
  parseCpFileRef,
  parseRemoteFileRef,
  posixBasename,
  posixDirname,
  posixJoin,
} from './files-path';

const UUID = '11111111-1111-4111-8111-111111111111';
const NODE = 'a'.repeat(32);

describe('isLocalPath / isRemoteSpec (scp rules)', () => {
  const LOCAL = [
    '/tmp/a',
    './a',
    '../a',
    '~/.ssh',
    '~',
    '.',
    '..',
    'dir',
    'a/b',
    'a/b:c',
    './a:b',
    'C:\\Windows',
    'c:/tmp/x',
    'file:///tmp/x',
    ':x',
    '~user:x',
  ];
  const REMOTE = [
    'office:',
    'office:home/docs',
    'office:/etc/hosts',
    'office:rel',
    'self:x',
    '.:x',
    'C:foo',
    `${UUID}:src/a.ts`,
    `${NODE}:${UUID}:src`,
    `${VIRTUAL_FS_ROOT_ID}:/etc`,
    `${VIRTUAL_HOME_ROOT_ID}:`,
  ];

  test.each(LOCAL)('local: %s', (input) => {
    expect(isLocalPath(input)).toBe(true);
    expect(isRemoteSpec(input)).toBe(false);
  });

  test.each(REMOTE)('remote: %s', (input) => {
    expect(isLocalPath(input)).toBe(false);
    expect(isRemoteSpec(input)).toBe(true);
  });

  test('empty is neither', () => {
    expect(isLocalPath('')).toBe(false);
    expect(isRemoteSpec('')).toBe(false);
  });
});

describe('parseCpFileRef', () => {
  const TABLE: Array<[string, unknown]> = [
    ['office:', { form: 'path', node: 'office', path: '' }],
    ['office:/etc/hosts', { form: 'path', node: 'office', path: '/etc/hosts' }],
    ['office:docs/a.txt', { form: 'path', node: 'office', path: 'docs/a.txt' }],
    ['office:home/docs', { form: 'path', node: 'office', path: 'home/docs' }],
    ['self:x', { form: 'path', node: 'self', path: 'x' }],
    ['.:x', { form: 'path', node: '.', path: 'x' }],
    [`${NODE}:x`, { form: 'path', node: NODE, path: 'x' }],
    [`${UUID}:src/a.ts`, { form: 'root', node: null, root: UUID, relpath: 'src/a.ts' }],
    [`${UUID}:/etc`, { form: 'root', node: null, root: UUID, relpath: '/etc' }],
    [`${UUID}:`, { form: 'root', node: null, root: UUID, relpath: '' }],
    [`${VIRTUAL_FS_ROOT_ID}:/etc`, { form: 'root', node: null, root: 'fs-root', relpath: '/etc' }],
    [`${VIRTUAL_HOME_ROOT_ID}:x`, { form: 'root', node: null, root: 'home-root', relpath: 'x' }],
    [`${NODE}:${UUID}:src`, { form: 'root', node: NODE, root: UUID, relpath: 'src' }],
    [
      `office:${VIRTUAL_HOME_ROOT_ID}:x`,
      { form: 'root', node: 'office', root: 'home-root', relpath: 'x' },
    ],
  ];

  test.each(TABLE)('%s', (input, expected) => {
    expect(parseCpFileRef(input)).toEqual(expected as never);
  });

  test('rejects local, empty and .. input', () => {
    expect(() => parseCpFileRef('')).toThrow(UsageError);
    expect(() => parseCpFileRef('dir')).toThrow(UsageError);
    expect(() => parseCpFileRef('a/b')).toThrow(UsageError);
    expect(() => parseCpFileRef('C:\\x')).toThrow(UsageError);
    expect(() => parseCpFileRef('office:a/../b')).toThrow(UsageError);
    expect(() => parseCpFileRef(`${UUID}:a/../b`)).toThrow(UsageError);
  });
});

describe('normalizePosixPath / isPathInside', () => {
  test('normalizes and rejects ..', () => {
    expect(normalizePosixPath('/a//b/./c/')).toBe('/a/b/c');
    expect(normalizePosixPath('/')).toBe('/');
    expect(() => normalizePosixPath('/a/../b')).toThrow(UsageError);
  });

  test('prefix is segment-aware', () => {
    expect(isPathInside('/data', '/data')).toBe(true);
    expect(isPathInside('/data', '/data/x')).toBe(true);
    expect(isPathInside('/data', '/data2')).toBe(false);
    expect(isPathInside('/', '/anything')).toBe(true);
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

  test('home-root virtual id colon form is not a node prefix', () => {
    expect(parseRemoteFileRef(`${VIRTUAL_HOME_ROOT_ID}:/tmp/x`)).toEqual({
      node: null,
      root: VIRTUAL_HOME_ROOT_ID,
      relpath: '/tmp/x',
    });
    expect(parseRemoteFileRef(`office:${VIRTUAL_HOME_ROOT_ID}/tmp/x`)).toEqual({
      node: 'office',
      root: VIRTUAL_HOME_ROOT_ID,
      relpath: 'tmp/x',
    });
    expect(parseRemoteFileRef(`${VIRTUAL_HOME_ROOT_ID}:`)).toEqual({
      node: null,
      root: VIRTUAL_HOME_ROOT_ID,
      relpath: '',
    });
  });

  test('rejects empty and local paths', () => {
    expect(() => parseRemoteFileRef('')).toThrow(UsageError);
    expect(() => parseRemoteFileRef('/tmp/a')).toThrow(UsageError);
  });

  test('rejects .. segments', () => {
    expect(() => parseRemoteFileRef('home/../etc')).toThrow(UsageError);
    expect(() => parseRemoteFileRef(`${UUID}:a/../../b`)).toThrow(UsageError);
  });

  test('trailing colon is the root itself', () => {
    expect(parseRemoteFileRef('home:')).toEqual({ node: null, root: 'home', relpath: '' });
    expect(parseRemoteFileRef(`${UUID}:`)).toEqual({ node: null, root: UUID, relpath: '' });
    expect(parseRemoteFileRef(`${VIRTUAL_FS_ROOT_ID}:`)).toEqual({
      node: null,
      root: VIRTUAL_FS_ROOT_ID,
      relpath: '',
    });
  });

  test('a root named / is addressed by id', () => {
    expect(parseRemoteFileRef(`${UUID}:/etc`)).toEqual({
      node: null,
      root: UUID,
      relpath: '/etc',
    });
    expect(parseRemoteFileRef(`${UUID}:etc`)).toEqual({ node: null, root: UUID, relpath: 'etc' });
  });
});

describe('joinRootPath', () => {
  test('joins relative and keeps absolute', () => {
    expect(joinRootPath('/home/me', 'docs/a')).toBe('/home/me/docs/a');
    expect(joinRootPath('/home/me', '/home/me/docs')).toBe('/home/me/docs');
    expect(joinRootPath('/home/me', '')).toBe('/home/me');
    expect(joinRootPath('/', 'etc')).toBe('/etc');
    expect(() => joinRootPath('/home/me', '../etc')).toThrow(UsageError);
  });

  test('basename and dirname', () => {
    expect(posixBasename('/home/me/a.txt')).toBe('a.txt');
    expect(posixDirname('/home/me/a.txt')).toBe('/home/me');
    expect(posixJoin('/home/me', 'docs')).toBe('/home/me/docs');
  });
});
