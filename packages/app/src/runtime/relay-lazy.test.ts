import { describe, expect, test } from 'bun:test';
import { loadRelayRuntime } from './relay-lazy';

describe('relay-lazy', () => {
  test('loadRelayRuntime memoizes createRelayRuntime', async () => {
    const first = await loadRelayRuntime();
    const second = await loadRelayRuntime();
    expect(first).toBe(second);
    expect(typeof first.createRelayRuntime).toBe('function');
  });
});
