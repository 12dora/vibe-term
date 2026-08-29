import { describe, expect, test } from 'bun:test';
import { reorderByIds } from './tmux-reorder';

interface Item {
  id: string;
  label: string;
}

const a: Item = { id: 'a', label: 'A' };
const b: Item = { id: 'b', label: 'B' };
const c: Item = { id: 'c', label: 'C' };

const cases: Array<{ name: string; items: Item[]; ids: string[]; expected: Item[] }> = [
  { name: 'empty ids keeps original order', items: [a, b, c], ids: [], expected: [a, b, c] },
  { name: 'empty items yields empty', items: [], ids: ['a'], expected: [] },
  {
    name: 'all ids known reorders fully',
    items: [a, b, c],
    ids: ['c', 'a', 'b'],
    expected: [c, a, b],
  },
  {
    name: 'partial ids move known first and keep remainder order',
    items: [a, b, c],
    ids: ['c'],
    expected: [c, a, b],
  },
  {
    name: 'unknown ids are dropped',
    items: [a, b, c],
    ids: ['zz', 'b', 'yy'],
    expected: [b, a, c],
  },
  {
    name: 'all ids unknown keeps original order',
    items: [a, b, c],
    ids: ['x', 'y'],
    expected: [a, b, c],
  },
  {
    name: 'duplicate ids are preserved in the known prefix',
    items: [a, b, c],
    ids: ['b', 'b', 'a'],
    expected: [b, b, a, c],
  },
  {
    name: 'duplicate items with the same id collapse to the last occurrence',
    items: [a, { id: 'a', label: 'A2' }, b],
    ids: ['a'],
    expected: [{ id: 'a', label: 'A2' }, b],
  },
];

describe('reorderByIds', () => {
  for (const { name, items, ids, expected } of cases) {
    test(name, () => {
      expect(reorderByIds(items, ids)).toEqual(expected);
    });
  }

  test('preserves item identity instead of cloning', () => {
    const result = reorderByIds([a, b, c], ['b']);
    expect(result[0]).toBe(b);
    expect(result[1]).toBe(a);
    expect(result[2]).toBe(c);
  });

  test('does not mutate the input array', () => {
    const items = [a, b, c];
    reorderByIds(items, ['c', 'b', 'a']);
    expect(items).toEqual([a, b, c]);
  });
});
