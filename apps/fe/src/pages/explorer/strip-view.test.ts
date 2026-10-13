import { describe, expect, test } from 'bun:test';
import type { ExplorerPane } from '@vibeterm/stores';
import { neighbourTabId, stripTabsView } from './strip-view';

const left: ExplorerPane = { id: 'p1', tabIds: ['a', 'b'], activeTabId: 'a' };
const right: ExplorerPane = { id: 'p2', tabIds: ['c'], activeTabId: 'c' };

describe('stripTabsView', () => {
  test('a regular strip lists only its own pane', () => {
    const view = stripTabsView([left, right], right, false);
    expect(view.tabIds).toEqual(['c']);
    expect(view.ownerOf.get('c')).toBe(right);
    expect(view.ownerOf.has('a')).toBe(false);
  });

  test('a merged strip lists every pane in pane order', () => {
    const view = stripTabsView([left, right], right, true);
    expect(view.tabIds).toEqual(['a', 'b', 'c']);
    expect(view.ownerOf.get('a')).toBe(left);
    expect(view.ownerOf.get('b')).toBe(left);
    expect(view.ownerOf.get('c')).toBe(right);
  });

  test('a tab id listed twice is kept once', () => {
    const dup: ExplorerPane = { id: 'p3', tabIds: ['a'], activeTabId: 'a' };
    expect(stripTabsView([left, dup], left, true).tabIds).toEqual(['a', 'b']);
  });
});

describe('neighbourTabId', () => {
  const ids = ['a', 'b', 'c'];

  test('moves to the adjacent tab', () => {
    expect(neighbourTabId(ids, 'b', 1)).toBe('c');
    expect(neighbourTabId(ids, 'b', -1)).toBe('a');
  });

  test('does not wrap at the ends', () => {
    expect(neighbourTabId(ids, 'a', -1)).toBeNull();
    expect(neighbourTabId(ids, 'c', 1)).toBeNull();
  });

  test('unknown tab has no neighbour', () => {
    expect(neighbourTabId(ids, 'x', 1)).toBeNull();
  });
});
