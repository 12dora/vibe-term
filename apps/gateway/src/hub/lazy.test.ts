import { describe, expect, test } from 'bun:test';
import { loadHubRuntime } from './lazy';

describe('hub/lazy', () => {
  test('loadHubRuntime memoizes HubRuntime', async () => {
    const first = await loadHubRuntime();
    const second = await loadHubRuntime();
    expect(first).toBe(second);
    expect(typeof first.HubRuntime).toBe('function');
  });
});
