import { describe, expect, test } from 'bun:test';
import { reorderDevicesOptimistically } from './device-reorder';

interface Row {
  id: string;
  sortOrder: number;
  name?: string;
}

function rows(...ids: string[]): Row[] {
  return ids.map((id, index) => ({ id, sortOrder: index, name: `n-${id}` }));
}

describe('reorderDevicesOptimistically', () => {
  test('按请求顺序重排并重写 sortOrder', () => {
    const next = reorderDevicesOptimistically(rows('a', 'b', 'c'), ['c', 'a', 'b']);

    expect(next.map((row) => [row.id, row.sortOrder])).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ]);
  });

  test('未在请求里的设备保持原相对顺序追加在后面', () => {
    const next = reorderDevicesOptimistically(rows('a', 'b', 'c', 'd'), ['c', 'a']);

    expect(next.map((row) => row.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(next.map((row) => row.sortOrder)).toEqual([0, 1, 1, 3]);
  });

  test('未知 id 被丢弃，且不会挤掉已有设备的槽位号', () => {
    const next = reorderDevicesOptimistically(rows('a', 'b'), ['ghost', 'b', 'a']);

    expect(next.map((row) => [row.id, row.sortOrder])).toEqual([
      ['b', 1],
      ['a', 2],
    ]);
  });

  test('不修改入参，其余字段原样保留', () => {
    const input = rows('a', 'b');
    const next = reorderDevicesOptimistically(input, ['b', 'a']);

    expect(input.map((row) => [row.id, row.sortOrder])).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
    expect(next[0]?.name).toBe('n-b');
    expect(next[0]).not.toBe(input[1]);
  });

  test('空请求列表原样返回', () => {
    const next = reorderDevicesOptimistically(rows('a', 'b'), []);

    expect(next.map((row) => [row.id, row.sortOrder])).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });
});
