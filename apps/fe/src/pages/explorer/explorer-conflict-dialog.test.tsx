// 只测不经 t() 的纯逻辑：同一次 `bun test` 里别的用例会把 `react-i18next` 进程级 mock 掉。

import { describe, expect, test } from 'bun:test';
import { CONFLICT_LIST_LIMIT, conflictNameList, conflictTitle } from './explorer-conflict-dialog';

describe('conflictTitle', () => {
  test('恰好一项：带名字的标题', () => {
    expect(conflictTitle(['a.txt'])).toEqual({
      key: 'explorer.conflict.titleOne',
      params: { name: 'a.txt' },
    });
  });

  test('两项及以上：数量标题', () => {
    expect(conflictTitle(['a.txt', 'b.txt'])).toEqual({
      key: 'explorer.conflict.titleMany',
      params: { count: 2 },
    });
    expect(conflictTitle(Array.from({ length: 12 }, (_, i) => `f${i}`)).params).toEqual({
      count: 12,
    });
  });
});

describe('conflictNameList', () => {
  test('只有一项时不列名字（标题里已经有了）', () => {
    expect(conflictNameList(['a.txt'])).toEqual({ shown: [], more: 0 });
  });

  test('不超过上限时全部列出', () => {
    expect(conflictNameList(['a', 'b', 'c'])).toEqual({ shown: ['a', 'b', 'c'], more: 0 });
  });

  test('超过上限时截断并给出剩余数量', () => {
    const names = Array.from({ length: CONFLICT_LIST_LIMIT + 3 }, (_, i) => `f${i}`);
    const list = conflictNameList(names);
    expect(list.shown).toEqual(names.slice(0, CONFLICT_LIST_LIMIT));
    expect(list.more).toBe(3);
  });
});
