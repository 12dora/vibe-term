import { describe, expect, test } from 'bun:test';
import { ImmediateScheduler } from './test-support';

describe('ImmediateScheduler', () => {
  test('sleep resolves without advancing now', async () => {
    const scheduler = new ImmediateScheduler();
    await scheduler.sleep(5_000);
    expect(scheduler.now()).toBe(1_000);
    expect(scheduler.sleeps).toBe(1);
  });

  test('sleep rejects when the signal is already aborted', async () => {
    const scheduler = new ImmediateScheduler();
    const ac = new AbortController();
    ac.abort(new Error('stopped'));
    await expect(scheduler.sleep(5_000, ac.signal)).rejects.toThrow('stopped');
    expect(scheduler.sleeps).toBe(0);
  });
});
