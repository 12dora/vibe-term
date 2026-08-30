import { describe, expect, test } from 'bun:test';

import { NODE_OFFLINE_ERROR, isNodePaused } from './agent-node-offline';

describe('isNodePaused', () => {
  test('follows the mesh signal when the host provides one', () => {
    expect(isNodePaused(true, null)).toBe(true);
    expect(isNodePaused(false, null)).toBe(false);
  });

  test('a node back online resumes input even while the session still holds NODE_OFFLINE', () => {
    expect(isNodePaused(false, NODE_OFFLINE_ERROR)).toBe(false);
  });

  test('falls back to the session error when the host has no mesh state', () => {
    expect(isNodePaused(undefined, NODE_OFFLINE_ERROR)).toBe(true);
    expect(isNodePaused(undefined, 'rate limited')).toBe(false);
    expect(isNodePaused(undefined, null)).toBe(false);
  });
});
