import { describe, expect, test } from 'bun:test';
import { aggregateByParent } from './stats';

describe('aggregateByParent', () => {
  test('folds rows into per-parent accumulators', () => {
    const rows = [
      { parentId: 'a', status: 'pending' },
      { parentId: 'b', status: 'authorized' },
      { parentId: 'a', status: 'authorized' },
      { parentId: 'a', status: 'pending' },
    ];

    const counters = aggregateByParent(
      rows,
      (row) => row.parentId,
      () => ({ pending: 0, authorized: 0 }),
      (acc, row) => {
        if (row.status === 'pending') acc.pending += 1;
        if (row.status === 'authorized') acc.authorized += 1;
      }
    );

    expect(counters.get('a')).toEqual({ pending: 2, authorized: 1 });
    expect(counters.get('b')).toEqual({ pending: 0, authorized: 1 });
    expect(counters.has('c')).toBe(false);
  });

  test('returns an empty map for no rows', () => {
    const counters = aggregateByParent(
      [] as Array<{ id: string }>,
      (row) => row.id,
      () => ({ n: 0 }),
      (acc) => {
        acc.n += 1;
      }
    );
    expect(counters.size).toBe(0);
  });
});
