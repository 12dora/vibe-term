import { describe, expect, test } from 'bun:test';
import { loadSsh2 } from './ssh2-lazy';

describe('ssh2-lazy', () => {
  test('loadSsh2 memoizes Client', async () => {
    const first = await loadSsh2();
    const second = await loadSsh2();
    expect(first).toBe(second);
    expect(typeof first.Client).toBe('function');
    expect(() => new first.Client()).not.toThrow();
  });
});
