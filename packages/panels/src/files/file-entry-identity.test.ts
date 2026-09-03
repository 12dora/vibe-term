// entry 引用稳定化：行级 memo 的存活条件（`FileLeaf` 的另外三个 prop 都是原始值，
// 只要 entry 引用不变，30 秒一轮的轮询就不会重渲染任何一行）。

import { describe, expect, test } from 'bun:test';
import type { FileEntryDto } from '@tmex/shared';
import { sameFileEntry, stabilizeFileEntries } from './file-entry-identity';

function entry(index: number, over: Partial<FileEntryDto> = {}): FileEntryDto {
  return {
    name: `f${index}.txt`,
    path: `/srv/local/f${index}.txt`,
    type: 'file',
    category: 'text',
    size: index,
    modifiedAt: null,
    isSymlink: false,
    ...over,
  };
}

const list = (count: number): FileEntryDto[] => Array.from({ length: count }, (_, i) => entry(i));

describe('stabilizeFileEntries', () => {
  test('内容完全相同的一轮轮询：数组与每一项都沿用旧引用（500 行零重渲染）', () => {
    const previous = list(500);
    const polled = list(500);
    expect(polled[0]).not.toBe(previous[0]);

    const next = stabilizeFileEntries(previous, polled);

    expect(next).toBe(previous);
    for (let i = 0; i < previous.length; i += 1) expect(next[i]).toBe(previous[i]);
  });

  test('目录里插入一个文件：插入点之后的每一项仍沿用旧引用', () => {
    const previous = list(500);
    const polled = [entry(9000), ...list(500)];

    const next = stabilizeFileEntries(previous, polled);

    expect(next).not.toBe(previous);
    expect(next.length).toBe(501);
    expect(next[0]).toBe(polled[0]);
    for (let i = 0; i < previous.length; i += 1) expect(next[i + 1]).toBe(previous[i]);
  });

  test('删除中间一项：其后各项沿用旧引用', () => {
    const previous = list(5);
    const polled = [previous[0], previous[2], previous[3], previous[4]].map((e) => ({
      ...(e as FileEntryDto),
    }));

    const next = stabilizeFileEntries(previous, polled);

    expect(next.map((e) => e.path)).toEqual(
      ['0', '2', '3', '4'].map((i) => `/srv/local/f${i}.txt`)
    );
    expect(next[0]).toBe(previous[0]);
    expect(next[1]).toBe(previous[2]);
    expect(next[3]).toBe(previous[4]);
  });

  test('内容真的变了的那一项换新对象，其余不受影响', () => {
    const previous = list(3);
    const polled = list(3);
    polled[1] = entry(1, { size: 999 });

    const next = stabilizeFileEntries(previous, polled);

    expect(next[0]).toBe(previous[0]);
    expect(next[1]).toBe(polled[1]);
    expect(next[2]).toBe(previous[2]);
  });

  test('没有上一份时原样返回', () => {
    const polled = list(3);
    expect(stabilizeFileEntries(undefined, polled)).toBe(polled);
    expect(stabilizeFileEntries([], polled)).toBe(polled);
  });
});

describe('sameFileEntry', () => {
  test('只要行渲染或菜单读到的字段变了就算不同', () => {
    const base = entry(1);
    expect(sameFileEntry(base, { ...base })).toBe(true);
    expect(sameFileEntry(base, { ...base, name: 'other' })).toBe(false);
    expect(sameFileEntry(base, { ...base, size: 2 })).toBe(false);
    expect(sameFileEntry(base, { ...base, isSymlink: true })).toBe(false);
    expect(sameFileEntry(base, { ...base, modifiedAt: '2026-09-03' })).toBe(false);
    expect(sameFileEntry(base, { ...base, category: 'code' })).toBe(false);
  });
});
