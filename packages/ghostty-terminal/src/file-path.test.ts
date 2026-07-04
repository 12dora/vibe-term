import { describe, expect, test } from 'bun:test';
import {
  isWithinRoots,
  normalizePosixPath,
  resolvePathCandidate,
  resolveValidFilePath,
} from './file-path';

describe('normalizePosixPath', () => {
  test('折叠 . 与连续斜杠', () => {
    expect(normalizePosixPath('/a/./b//c/')).toBe('/a/b/c');
  });

  test('解析 ..，越过根停在根', () => {
    expect(normalizePosixPath('/a/b/../c')).toBe('/a/c');
    expect(normalizePosixPath('/../../x')).toBe('/x');
    expect(normalizePosixPath('/a/..')).toBe('/');
  });
});

describe('resolvePathCandidate', () => {
  test('绝对路径直接归一化', () => {
    expect(resolvePathCandidate('/a/../b.txt', null)).toBe('/b.txt');
  });

  test('相对路径基于 cwd 解析', () => {
    expect(resolvePathCandidate('src/a.ts', '/home/u/proj')).toBe('/home/u/proj/src/a.ts');
    expect(resolvePathCandidate('../x.log', '/home/u/proj')).toBe('/home/u/x.log');
    expect(resolvePathCandidate('./y', '/home/u')).toBe('/home/u/y');
  });

  test('无 cwd 或 cwd 非绝对路径时相对路径不可解析', () => {
    expect(resolvePathCandidate('a/b', null)).toBeNull();
    expect(resolvePathCandidate('a/b', 'rel/cwd')).toBeNull();
  });
});

describe('isWithinRoots', () => {
  test('前缀匹配按路径段边界', () => {
    expect(isWithinRoots('/data/proj/a.ts', ['/data/proj'])).toBe(true);
    expect(isWithinRoots('/data/proj', ['/data/proj'])).toBe(true);
    expect(isWithinRoots('/data/proj2/a.ts', ['/data/proj'])).toBe(false);
  });

  test('根为 / 时任意绝对路径均有效', () => {
    expect(isWithinRoots('/etc/hosts', ['/'])).toBe(true);
  });

  test('根路径末尾斜杠被归一化', () => {
    expect(isWithinRoots('/data/proj/a.ts', ['/data/proj/'])).toBe(true);
  });
});

describe('resolveValidFilePath', () => {
  const context = { cwd: '/home/u/proj', rootPaths: ['/home/u/proj', '/var/log'] };

  test('相对路径落在授权根内', () => {
    expect(resolveValidFilePath('src/a.ts', context)).toBe('/home/u/proj/src/a.ts');
  });

  test('绝对路径落在另一授权根内', () => {
    expect(resolveValidFilePath('/var/log/app.log', context)).toBe('/var/log/app.log');
  });

  test('.. 逃出授权根后无效', () => {
    expect(resolveValidFilePath('../../secret', context)).toBeNull();
  });

  test('无上下文或无授权根时一律无效', () => {
    expect(resolveValidFilePath('/var/log/app.log', null)).toBeNull();
    expect(resolveValidFilePath('/var/log/app.log', { cwd: '/x', rootPaths: [] })).toBeNull();
  });
});
