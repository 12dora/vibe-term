import { describe, expect, it } from 'bun:test';
import { basename, dirname, normalizePosixPath } from './posix-path';

describe('basename', () => {
  it('取最后一段，无分隔符时返回原串', () => {
    expect(basename('/home/me/notes.txt')).toBe('notes.txt');
    expect(basename('notes.txt')).toBe('notes.txt');
  });

  it('末段为空时回退原串（根与结尾斜杠）', () => {
    expect(basename('/')).toBe('/');
    expect(basename('/home/me/')).toBe('/home/me/');
  });
});

describe('dirname', () => {
  it('取父目录，顶层与根都归到 /', () => {
    expect(dirname('/home/me/notes.txt')).toBe('/home/me');
    expect(dirname('/home')).toBe('/');
    expect(dirname('/')).toBe('/');
    expect(dirname('notes.txt')).toBe('/');
  });
});

describe('normalizePosixPath', () => {
  it('折叠 . 与连续斜杠', () => {
    expect(normalizePosixPath('/a//b/./c')).toBe('/a/b/c');
    expect(normalizePosixPath('/')).toBe('/');
  });

  it('绝对路径的 .. 越过根时停在根', () => {
    expect(normalizePosixPath('/a/b/../c')).toBe('/a/c');
    expect(normalizePosixPath('/a/../../b')).toBe('/b');
  });

  it('相对路径自动识别并保留前导 ..', () => {
    expect(normalizePosixPath('a/b/../c')).toBe('a/c');
    expect(normalizePosixPath('../../img.png')).toBe('../../img.png');
    expect(normalizePosixPath('a/../../img.png')).toBe('../img.png');
  });

  it('relative 选项强制相对语义', () => {
    expect(normalizePosixPath('/a/b', { relative: true })).toBe('a/b');
    expect(normalizePosixPath('a/b', { relative: false })).toBe('/a/b');
  });
});
