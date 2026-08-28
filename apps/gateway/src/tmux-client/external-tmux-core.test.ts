import { describe, expect, test } from 'bun:test';

import {
  BELL_DEDUP_WINDOW_MS,
  createBellDedupBook,
  hasRenderableTerminalContent,
  isTmuxServerGoneMessage,
  noteBellDedup,
} from './external-tmux-core';

describe('external tmux core helpers', () => {
  test('hasRenderableTerminalContent ignores empty and whitespace-only screens', () => {
    expect(hasRenderableTerminalContent('')).toBe(false);
    expect(hasRenderableTerminalContent('   \n\t')).toBe(false);
    expect(hasRenderableTerminalContent(' $ ')).toBe(true);
  });

  test('isTmuxServerGoneMessage classifies tmux disappearance strings', () => {
    expect(isTmuxServerGoneMessage("can't find session: tmex")).toBe(true);
    expect(isTmuxServerGoneMessage('no server running on /tmp/tmux-1000/default')).toBe(true);
    expect(isTmuxServerGoneMessage('lost server')).toBe(true);
    expect(isTmuxServerGoneMessage('session not found')).toBe(true);
    expect(isTmuxServerGoneMessage('no such session')).toBe(true);
    expect(isTmuxServerGoneMessage('no sessions')).toBe(true);
    expect(isTmuxServerGoneMessage("can't find pane: %1")).toBe(false);
    expect(isTmuxServerGoneMessage('permission denied')).toBe(false);
  });
});

describe('bellDedup TTL prune', () => {
  test('suppresses repeats inside the dedup window and emits after it', () => {
    const book = createBellDedupBook();
    expect(noteBellDedup(book, '%1', 1_000)).toBe(true);
    expect(noteBellDedup(book, '%1', 1_000 + BELL_DEDUP_WINDOW_MS - 1)).toBe(false);
    expect(noteBellDedup(book, '%1', 1_000 + BELL_DEDUP_WINDOW_MS)).toBe(true);
    expect(book.entries.get('%1')).toBe(1_000 + BELL_DEDUP_WINDOW_MS);
  });

  test('does not prune on every insert, only every N inserts', () => {
    const book = createBellDedupBook();
    book.lastPruneAt = 1_000;
    book.entries.set('old', 0);

    expect(noteBellDedup(book, '%a', 1_000, BELL_DEDUP_WINDOW_MS, 3)).toBe(true);
    expect(book.entries.has('old')).toBe(true);
    expect(noteBellDedup(book, '%b', 1_000, BELL_DEDUP_WINDOW_MS, 3)).toBe(true);
    expect(book.entries.has('old')).toBe(true);

    expect(noteBellDedup(book, '%c', 1_000, BELL_DEDUP_WINDOW_MS, 3)).toBe(true);
    expect(book.entries.has('old')).toBe(false);
    expect([...book.entries.keys()].sort()).toEqual(['%a', '%b', '%c']);
    expect(book.insertsSincePrune).toBe(0);
  });

  test('prunes expired entries after the dedup window even before N inserts', () => {
    const book = createBellDedupBook();
    book.entries.set('stale', 0);
    book.entries.set('fresh', 900);
    book.lastPruneAt = 0;

    expect(noteBellDedup(book, '%new', 1_000, 200, 32)).toBe(true);
    expect(book.entries.has('stale')).toBe(false);
    expect(book.entries.has('fresh')).toBe(true);
    expect(book.entries.get('%new')).toBe(1_000);
  });

  test('dedup still works for a key that survived prune', () => {
    const book = createBellDedupBook();
    book.lastPruneAt = 1_000;
    expect(noteBellDedup(book, '%keep', 1_000, 200, 2)).toBe(true);
    book.entries.set('old', 0);
    expect(noteBellDedup(book, '%other', 1_000, 200, 2)).toBe(true);

    expect(book.entries.has('old')).toBe(false);
    expect(noteBellDedup(book, '%keep', 1_150, 200, 2)).toBe(false);
    expect(noteBellDedup(book, '%keep', 1_200, 200, 2)).toBe(true);
  });
});
