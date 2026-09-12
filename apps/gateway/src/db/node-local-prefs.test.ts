import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getDb } from './client';
import { runMigrations } from './migrate';
import { getNodeLocalPaused, listPausedNodeIds, setNodeLocalPaused } from './node-local-prefs';
import { nodeLocalPrefs } from './schema';

const A = 'aa'.repeat(16);
const B = 'bb'.repeat(16);

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  getDb().delete(nodeLocalPrefs).run();
});

describe('node_local_prefs', () => {
  test('set/get/list roundtrip', () => {
    expect(getNodeLocalPaused(A)).toBe(false);
    expect(listPausedNodeIds()).toEqual([]);
    setNodeLocalPaused(A, true);
    setNodeLocalPaused(B, true);
    expect(getNodeLocalPaused(A)).toBe(true);
    expect(new Set(listPausedNodeIds())).toEqual(new Set([A, B]));
    setNodeLocalPaused(A, false);
    expect(getNodeLocalPaused(A)).toBe(false);
    expect(listPausedNodeIds()).toEqual([B]);
  });

  test('resume is idempotent and pause overwrites', () => {
    setNodeLocalPaused(A, false);
    setNodeLocalPaused(A, false);
    expect(getNodeLocalPaused(A)).toBe(false);
    setNodeLocalPaused(A, true);
    setNodeLocalPaused(A, true);
    expect(getNodeLocalPaused(A)).toBe(true);
    expect(listPausedNodeIds()).toEqual([A]);
  });
});
