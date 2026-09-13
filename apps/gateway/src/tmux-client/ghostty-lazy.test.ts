import { describe, expect, test } from 'bun:test';
import { loadGhosttyHeadless } from './ghostty-lazy';

describe('ghostty-lazy', () => {
  test('loadGhosttyHeadless memoizes HeadlessTerminal', async () => {
    const first = await loadGhosttyHeadless();
    const second = await loadGhosttyHeadless();
    expect(first).toBe(second);
    expect(typeof first.HeadlessTerminal.create).toBe('function');
  });
});
