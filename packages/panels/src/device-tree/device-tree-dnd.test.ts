import { describe, expect, test } from 'bun:test';
import type { DragEndEvent } from '@dnd-kit/core';
import { reorderIdsByDragEnd } from './device-tree-dnd';

const dragEvent = (activeId: string, overId: string | null) =>
  ({
    active: { id: activeId },
    over: overId === null ? null : { id: overId },
  }) as DragEndEvent;

describe('reorderIdsByDragEnd', () => {
  const ids = ['a', 'b', 'c', 'd'];

  test('moves the dragged id to the drop target index', () => {
    expect(reorderIdsByDragEnd(ids, dragEvent('a', 'c'))).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderIdsByDragEnd(ids, dragEvent('d', 'a'))).toEqual(['d', 'a', 'b', 'c']);
  });

  test('does not mutate the input order', () => {
    reorderIdsByDragEnd(ids, dragEvent('a', 'c'));
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });

  test('returns null when there is no drop target', () => {
    expect(reorderIdsByDragEnd(ids, dragEvent('a', null))).toBeNull();
  });

  test('returns null when dropped on itself', () => {
    expect(reorderIdsByDragEnd(ids, dragEvent('b', 'b'))).toBeNull();
  });

  test('returns null when either id is unknown', () => {
    expect(reorderIdsByDragEnd(ids, dragEvent('z', 'b'))).toBeNull();
    expect(reorderIdsByDragEnd(ids, dragEvent('b', 'z'))).toBeNull();
  });
});
