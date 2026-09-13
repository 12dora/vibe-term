import { describe, expect, test } from 'bun:test';
import { loadWatchService } from './lazy';

describe('watch/lazy', () => {
  test('loadWatchService memoizes the singleton', async () => {
    const first = await loadWatchService();
    const second = await loadWatchService();
    expect(first).toBe(second);
    expect(typeof first.watchService.start).toBe('function');
  });
});
