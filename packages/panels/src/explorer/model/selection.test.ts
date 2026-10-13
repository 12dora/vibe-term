import { describe, expect, test } from 'bun:test';
import {
  EMPTY_SELECTION,
  type SelectionState,
  moveFocus,
  pruneSelection,
  selectAll,
  selectByRect,
  selectOnly,
  selectRange,
  toggleOne,
} from './selection';

const ORDER = ['/a', '/b', '/c', '/d', '/e'];

function state(selected: string[], anchor: string | null, focus: string | null): SelectionState {
  return { selected: new Set(selected), anchor, focus };
}

const picked = (value: SelectionState) => [...value.selected].sort();

describe('selectOnly / toggleOne', () => {
  test('selectOnly replaces everything', () => {
    const next = selectOnly('/b');
    expect(picked(next)).toEqual(['/b']);
    expect(next.anchor).toBe('/b');
    expect(next.focus).toBe('/b');
  });

  test('toggleOne adds and removes, moving anchor and focus', () => {
    const added = toggleOne(selectOnly('/a'), '/c');
    expect(picked(added)).toEqual(['/a', '/c']);
    expect(added.anchor).toBe('/c');
    expect(added.focus).toBe('/c');

    const removed = toggleOne(added, '/a');
    expect(picked(removed)).toEqual(['/c']);
    expect(removed.anchor).toBe('/a');
    expect(removed.focus).toBe('/a');
  });

  test('toggleOne does not mutate the previous state', () => {
    const base = selectOnly('/a');
    toggleOne(base, '/b');
    expect(picked(base)).toEqual(['/a']);
  });
});

describe('selectRange', () => {
  test('ranges from the anchor in both directions and keeps it', () => {
    const down = selectRange(selectOnly('/b'), ORDER, '/d');
    expect(picked(down)).toEqual(['/b', '/c', '/d']);
    expect(down.anchor).toBe('/b');
    expect(down.focus).toBe('/d');

    const up = selectRange(down, ORDER, '/a');
    expect(picked(up)).toEqual(['/a', '/b']);
    expect(up.anchor).toBe('/b');
    expect(up.focus).toBe('/a');
  });

  test('replaces the selection unless additive', () => {
    const base = state(['/a', '/e'], '/c', '/c');
    expect(picked(selectRange(base, ORDER, '/d'))).toEqual(['/c', '/d']);
    expect(picked(selectRange(base, ORDER, '/d', true))).toEqual(['/a', '/c', '/d', '/e']);
  });

  test('falls back to focus, then to the first item', () => {
    const fromFocus = selectRange(state([], null, '/d'), ORDER, '/b');
    expect(picked(fromFocus)).toEqual(['/b', '/c', '/d']);
    expect(fromFocus.anchor).toBe('/d');
    expect(fromFocus.focus).toBe('/b');

    const fromFirst = selectRange(EMPTY_SELECTION, ORDER, '/c');
    expect(picked(fromFirst)).toEqual(['/a', '/b', '/c']);
    expect(fromFirst.anchor).toBe('/a');
  });

  test('a stale anchor is skipped', () => {
    const next = selectRange(state(['/gone'], '/gone', '/e'), ORDER, '/d');
    expect(picked(next)).toEqual(['/d', '/e']);
    expect(next.anchor).toBe('/e');
  });

  test('an unknown target leaves the state untouched', () => {
    const base = selectOnly('/a');
    expect(selectRange(base, ORDER, '/nope')).toBe(base);
  });
});

describe('selectAll', () => {
  test('selects every path', () => {
    const all = selectAll(ORDER);
    expect(picked(all)).toEqual(ORDER);
    expect(all.anchor).toBe('/a');
    expect(all.focus).toBe('/a');
  });

  test('an empty list is the empty selection', () => {
    expect(selectAll([])).toBe(EMPTY_SELECTION);
  });
});

describe('moveFocus', () => {
  test('moves and clamps', () => {
    expect(moveFocus(selectOnly('/b'), ORDER, 1, { extend: false })).toEqual(selectOnly('/c'));
    expect(moveFocus(selectOnly('/b'), ORDER, -1, { extend: false })).toEqual(selectOnly('/a'));
    expect(moveFocus(selectOnly('/b'), ORDER, -10, { extend: false })).toEqual(selectOnly('/a'));
    expect(moveFocus(selectOnly('/d'), ORDER, 10, { extend: false })).toEqual(selectOnly('/e'));
  });

  test('uses the anchor when there is no focus', () => {
    expect(moveFocus(state(['/c'], '/c', null), ORDER, 1, { extend: false })).toEqual(
      selectOnly('/d')
    );
  });

  test('with nothing focused goes to the first or last item', () => {
    expect(moveFocus(EMPTY_SELECTION, ORDER, 1, { extend: false })).toEqual(selectOnly('/a'));
    expect(moveFocus(EMPTY_SELECTION, ORDER, 3, { extend: false })).toEqual(selectOnly('/a'));
    expect(moveFocus(EMPTY_SELECTION, ORDER, -1, { extend: false })).toEqual(selectOnly('/e'));
    expect(moveFocus(EMPTY_SELECTION, ORDER, -1, { extend: true })).toEqual(selectOnly('/e'));
    expect(moveFocus(state([], '/gone', '/gone'), ORDER, 1, { extend: true })).toEqual(
      selectOnly('/a')
    );
  });

  test('infinite deltas jump to the ends', () => {
    const base = selectOnly('/c');
    expect(moveFocus(base, ORDER, Number.NEGATIVE_INFINITY, { extend: false })).toEqual(
      selectOnly('/a')
    );
    expect(moveFocus(base, ORDER, Number.POSITIVE_INFINITY, { extend: false })).toEqual(
      selectOnly('/e')
    );
    expect(moveFocus(EMPTY_SELECTION, ORDER, Number.POSITIVE_INFINITY, { extend: false })).toEqual(
      selectOnly('/e')
    );
  });

  test('extend grows and shrinks the range around the anchor', () => {
    const one = moveFocus(selectOnly('/b'), ORDER, 1, { extend: true });
    expect(picked(one)).toEqual(['/b', '/c']);
    expect(one.anchor).toBe('/b');
    expect(one.focus).toBe('/c');

    const two = moveFocus(one, ORDER, 1, { extend: true });
    expect(picked(two)).toEqual(['/b', '/c', '/d']);

    const back = moveFocus(two, ORDER, -3, { extend: true });
    expect(picked(back)).toEqual(['/a', '/b']);
    expect(back.anchor).toBe('/b');
    expect(back.focus).toBe('/a');

    const end = moveFocus(back, ORDER, Number.POSITIVE_INFINITY, { extend: true });
    expect(picked(end)).toEqual(['/b', '/c', '/d', '/e']);
  });

  test('an empty list yields the empty selection', () => {
    expect(moveFocus(selectOnly('/a'), [], 1, { extend: false })).toBe(EMPTY_SELECTION);
    expect(moveFocus(selectOnly('/a'), [], -1, { extend: true })).toBe(EMPTY_SELECTION);
  });
});

describe('pruneSelection', () => {
  test('drops vanished paths and repairs anchor and focus', () => {
    const next = pruneSelection(state(['/a', '/x', '/c'], '/x', '/c'), ORDER);
    expect(picked(next)).toEqual(['/a', '/c']);
    expect(next.anchor).toBeNull();
    expect(next.focus).toBe('/c');

    const focusGone = pruneSelection(state(['/a'], '/a', '/x'), ORDER);
    expect(picked(focusGone)).toEqual(['/a']);
    expect(focusGone.anchor).toBe('/a');
    expect(focusGone.focus).toBeNull();
  });

  test('returns the same reference when nothing changed', () => {
    const base = state(['/a', '/b'], '/a', '/b');
    expect(pruneSelection(base, ORDER)).toBe(base);
    expect(pruneSelection(EMPTY_SELECTION, [])).toBe(EMPTY_SELECTION);
  });

  test('an empty list clears everything', () => {
    const next = pruneSelection(state(['/a'], '/a', '/a'), []);
    expect(next.selected.size).toBe(0);
    expect(next.anchor).toBeNull();
    expect(next.focus).toBeNull();
  });
});

describe('selectByRect', () => {
  const base = state(['/a'], '/a', '/a');

  test('replaces the selection with the hit set', () => {
    const next = selectByRect(ORDER, new Set(['/d', '/c']), base, false);
    expect(picked(next)).toEqual(['/c', '/d']);
    expect(next.anchor).toBe('/d');
    expect(next.focus).toBe('/d');
  });

  test('additive unions with the base selection', () => {
    const next = selectByRect(ORDER, new Set(['/e', '/c']), base, true);
    expect(picked(next)).toEqual(['/a', '/c', '/e']);
    expect(next.anchor).toBe('/e');
    expect(next.focus).toBe('/e');
  });

  test('an empty hit keeps the base anchor and focus', () => {
    const cleared = selectByRect(ORDER, new Set(), base, false);
    expect(cleared.selected.size).toBe(0);
    expect(cleared.anchor).toBe('/a');
    expect(cleared.focus).toBe('/a');

    const kept = selectByRect(ORDER, new Set(), base, true);
    expect(picked(kept)).toEqual(['/a']);
    expect(kept.focus).toBe('/a');
  });
});
