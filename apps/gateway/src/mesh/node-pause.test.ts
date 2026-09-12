import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { getDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { nodeLocalPrefs } from '../db/schema';
import {
  isNodePaused,
  pausedNodeIds,
  rejectPausedUserLink,
  reloadNodePauseFromDbForTests,
  resetNodePauseForTests,
  setNodePaused,
} from './node-pause';
import { NodeUnreachableError } from './types';

const A = 'aa'.repeat(16);

beforeAll(() => {
  runMigrations();
});

afterEach(() => {
  getDb().delete(nodeLocalPrefs).run();
  resetNodePauseForTests();
});

describe('node-pause', () => {
  test('set/is/list and default getLink purpose rejects paused', () => {
    expect(isNodePaused(A)).toBe(false);
    setNodePaused(A, true);
    expect(isNodePaused(A)).toBe(true);
    expect([...pausedNodeIds()]).toEqual([A]);
    expect(() => rejectPausedUserLink(A)).toThrow(NodeUnreachableError);
    expect(() => rejectPausedUserLink(A, 'user')).toThrow(NodeUnreachableError);
    expect(() => rejectPausedUserLink(A, 'management')).not.toThrow();
    setNodePaused(A, false);
    expect(isNodePaused(A)).toBe(false);
    expect(() => rejectPausedUserLink(A)).not.toThrow();
  });

  test('reload from sqlite after clearing the in-memory set (restart)', () => {
    setNodePaused(A, true);
    resetNodePauseForTests();
    expect(isNodePaused(A)).toBe(false);
    reloadNodePauseFromDbForTests();
    expect(isNodePaused(A)).toBe(true);
  });
});
