import { describe, expect, test } from 'bun:test';

import { MinHeap } from './min-heap';

describe('MinHeap', () => {
  test('pops values in comparator order and ignores empty pops', () => {
    const heap = new MinHeap<number>((left, right) => left - right);
    heap.push(4);
    heap.push(1);
    heap.push(3);
    heap.push(2);
    expect(heap.size).toBe(4);
    expect(heap.pop()).toBe(1);
    expect(heap.pop()).toBe(2);
    expect(heap.pop()).toBe(3);
    expect(heap.pop()).toBe(4);
    expect(heap.pop()).toBeUndefined();
    expect(heap.size).toBe(0);
  });
});
