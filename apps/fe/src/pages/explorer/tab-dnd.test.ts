import { afterEach, describe, expect, test } from 'bun:test';
import {
  EXPLORER_TAB_MIME,
  adjustIndexForSamePane,
  getDraggedTabId,
  hasOsFileDrag,
  hasTabDrag,
  insertionIndex,
  setDraggedTabId,
  tabFileDropEffect,
} from './tab-dnd';

describe('insertionIndex', () => {
  const midpoints = [50, 150, 250];

  test('before the first midpoint inserts at the start', () => {
    expect(insertionIndex(midpoints, 0)).toBe(0);
    expect(insertionIndex(midpoints, 49)).toBe(0);
  });

  test('between midpoints inserts after the passed tab', () => {
    expect(insertionIndex(midpoints, 50)).toBe(1);
    expect(insertionIndex(midpoints, 149)).toBe(1);
    expect(insertionIndex(midpoints, 200)).toBe(2);
  });

  test('past the last midpoint appends', () => {
    expect(insertionIndex(midpoints, 250)).toBe(3);
    expect(insertionIndex(midpoints, 9999)).toBe(3);
  });

  test('an empty strip inserts at zero', () => {
    expect(insertionIndex([], 120)).toBe(0);
  });
});

describe('adjustIndexForSamePane', () => {
  test('moving left keeps the insertion slot', () => {
    expect(adjustIndexForSamePane(2, 0)).toBe(0);
    expect(adjustIndexForSamePane(2, 1)).toBe(1);
  });

  test('moving right shifts by the removed tab', () => {
    expect(adjustIndexForSamePane(0, 2)).toBe(1);
    expect(adjustIndexForSamePane(0, 3)).toBe(2);
  });

  test('dropping next to itself is a no-op position', () => {
    expect(adjustIndexForSamePane(1, 1)).toBe(1);
    expect(adjustIndexForSamePane(1, 2)).toBe(1);
  });

  test('a tab that is not in the pane keeps the slot', () => {
    expect(adjustIndexForSamePane(-1, 2)).toBe(2);
  });

  test('matches remove-then-insert on a real list', () => {
    const tabs = ['a', 'b', 'c', 'd'];
    for (let from = 0; from < tabs.length; from += 1) {
      for (let slot = 0; slot <= tabs.length; slot += 1) {
        // 期望：在原列表的 slot 位之前插入，再去掉原来的那一个
        const marked = [...tabs.slice(0, slot), '*', ...tabs.slice(slot)];
        const expected = marked
          .filter((id) => id !== tabs[from])
          .map((id) => (id === '*' ? tabs[from] : id));
        const rest = tabs.filter((id) => id !== tabs[from]);
        const index = adjustIndexForSamePane(from, slot);
        const actual = [...rest.slice(0, index), tabs[from], ...rest.slice(index)];
        expect(actual).toEqual(expected);
      }
    }
  });
});

describe('tabFileDropEffect', () => {
  test('same node moves unless a copy modifier is held', () => {
    expect(tabFileDropEffect('self', 'self', false)).toBe('move');
    expect(tabFileDropEffect('self', 'self', true)).toBe('copy');
  });

  test('other or unknown source node copies', () => {
    expect(tabFileDropEffect('abc', 'self', false)).toBe('copy');
    expect(tabFileDropEffect(null, 'self', false)).toBe('copy');
    expect(tabFileDropEffect(undefined, 'self', false)).toBe('copy');
  });
});

describe('drag type checks', () => {
  test('detects a tab drag', () => {
    expect(hasTabDrag({ types: [EXPLORER_TAB_MIME] })).toBe(true);
    expect(hasTabDrag({ types: ['Files'] })).toBe(false);
  });

  test('detects an OS file drag', () => {
    expect(hasOsFileDrag({ types: ['Files'] })).toBe(true);
    expect(hasOsFileDrag({ types: ['text/plain'] })).toBe(false);
  });
});

describe('dragged tab mirror', () => {
  afterEach(() => setDraggedTabId(null));

  test('remembers and clears the dragged tab id', () => {
    expect(getDraggedTabId()).toBeNull();
    setDraggedTabId('tab-1');
    expect(getDraggedTabId()).toBe('tab-1');
    setDraggedTabId(null);
    expect(getDraggedTabId()).toBeNull();
  });
});
