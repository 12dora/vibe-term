import { describe, expect, test } from 'bun:test';
import { loadTunnelManager } from './lazy';

describe('tunnel/lazy', () => {
  test('loadTunnelManager memoizes the singleton', async () => {
    const first = await loadTunnelManager();
    const second = await loadTunnelManager();
    expect(first).toBe(second);
    expect(typeof first.tunnelManager.start).toBe('function');
  });
});
