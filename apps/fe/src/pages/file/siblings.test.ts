import { describe, expect, test } from 'bun:test';
import type { FileCategory, FileEntryDto } from '@vibeterm/shared';
import { pickSiblings } from './siblings';

function file(
  name: string,
  category: FileCategory = 'image',
  extra: Partial<FileEntryDto> = {}
): FileEntryDto {
  return {
    name,
    path: `/d/${name}`,
    type: 'file',
    category,
    size: 1,
    modifiedAt: null,
    isSymlink: false,
    ...extra,
  };
}

function dir(name: string): FileEntryDto {
  return file(name, 'directory', { type: 'dir', size: null });
}

const BY_NAME = { sort: { key: 'name', dir: 'asc' }, showHidden: false } as const;

function names(result: ReturnType<typeof pickSiblings>): [string | null, string | null] | null {
  return result && [result.prev?.name ?? null, result.next?.name ?? null];
}

describe('pickSiblings', () => {
  const entries = [file('c.png'), file('a.png'), file('b.png')];

  test('按文件管理器的排序给出前后邻居（与列表原始顺序无关）', () => {
    expect(names(pickSiblings(entries, '/d/b.png', BY_NAME))).toEqual(['a.png', 'c.png']);
  });

  test('首尾没有对应一侧，不循环', () => {
    expect(names(pickSiblings(entries, '/d/a.png', BY_NAME))).toEqual([null, 'b.png']);
    expect(names(pickSiblings(entries, '/d/c.png', BY_NAME))).toEqual(['b.png', null]);
  });

  test('数字按自然序，倒序时前后互换', () => {
    const numbered = [file('10.png'), file('2.png'), file('1.png')];
    expect(names(pickSiblings(numbered, '/d/2.png', BY_NAME))).toEqual(['1.png', '10.png']);
    const desc = { sort: { key: 'name', dir: 'desc' }, showHidden: false } as const;
    expect(names(pickSiblings(numbered, '/d/2.png', desc))).toEqual(['10.png', '1.png']);
  });

  test('其它排序键：按大小', () => {
    const sized = [
      file('a.png', 'image', { size: 30 }),
      file('b.png', 'image', { size: 10 }),
      file('c.png', 'image', { size: 20 }),
    ];
    const bySize = { sort: { key: 'size', dir: 'asc' }, showHidden: false } as const;
    expect(names(pickSiblings(sized, '/d/c.png', bySize))).toEqual(['b.png', 'a.png']);
  });

  test('目录置顶且不参与切换', () => {
    const mixed = [file('b.png'), dir('a-dir'), file('c.png')];
    expect(names(pickSiblings(mixed, '/d/b.png', BY_NAME))).toEqual([null, 'c.png']);
  });

  test('不可预览的文件被跳过，继续找更远的邻居', () => {
    const mixed = [
      file('a.png'),
      file('b.zip', 'archive'),
      file('c.bin', 'binary'),
      file('d.png'),
      file('e.dat', 'other'),
    ];
    expect(names(pickSiblings(mixed, '/d/a.png', BY_NAME))).toEqual([null, 'd.png']);
    expect(names(pickSiblings(mixed, '/d/d.png', BY_NAME))).toEqual(['a.png', null]);
  });

  test('各类可预览文件互为邻居', () => {
    const kinds: FileCategory[] = ['image', 'pdf', 'audio', 'video', 'code', 'markdown', 'text'];
    const all = kinds.map((category, i) => file(`${i}.x`, category));
    expect(names(pickSiblings(all, '/d/3.x', BY_NAME))).toEqual(['2.x', '4.x']);
    expect(names(pickSiblings(all, '/d/0.x', BY_NAME))).toEqual([null, '1.x']);
  });

  test('隐藏文件：开关关闭时被跳过，打开时参与', () => {
    const withHidden = [file('.a.png'), file('b.png'), file('c.png')];
    expect(names(pickSiblings(withHidden, '/d/b.png', BY_NAME))).toEqual([null, 'c.png']);
    const shown = { ...BY_NAME, showHidden: true };
    expect(names(pickSiblings(withHidden, '/d/b.png', shown))).toEqual(['.a.png', 'c.png']);
  });

  test('当前文件自己是隐藏文件时仍作为定位点保留', () => {
    // 点开头的名字在名称排序里排在字母之前：.a 被开关挡住，.c 作为定位点保留，下一个是 b
    const withHidden = [file('.a.png'), file('b.png'), file('.c.png'), file('d.png')];
    expect(names(pickSiblings(withHidden, '/d/.c.png', BY_NAME))).toEqual([null, 'b.png']);
  });

  test('当前文件本身不可预览也能定位邻居', () => {
    const mixed = [file('a.png'), file('b.zip', 'archive'), file('c.png')];
    expect(names(pickSiblings(mixed, '/d/b.zip', BY_NAME))).toEqual(['a.png', 'c.png']);
  });

  test('列表里找不到当前文件 → null（不显示箭头）', () => {
    expect(pickSiblings(entries, '/d/gone.png', BY_NAME)).toBeNull();
    expect(pickSiblings([], '/d/a.png', BY_NAME)).toBeNull();
  });

  test('只有它自己时前后都没有', () => {
    expect(names(pickSiblings([file('a.png')], '/d/a.png', BY_NAME))).toEqual([null, null]);
  });

  test('返回列表里的当前条目（stat 未就绪时用它的类别）', () => {
    const mixed = [file('a.png'), file('b.pdf', 'pdf')];
    expect(pickSiblings(mixed, '/d/b.pdf', BY_NAME)?.current.category).toBe('pdf');
  });
});
