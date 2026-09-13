import { describe, expect, test } from 'bun:test';
import { AsyncMutex } from './async-mutex';

describe('AsyncMutex', () => {
  test('second run waits until the first finishes', async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = mutex.runExclusive(async () => {
      order.push('first-enter');
      await firstHold;
      order.push('first-leave');
      return 1;
    });
    const second = mutex.runExclusive(async () => {
      order.push('second');
      return 2;
    });
    await Promise.resolve();
    expect(order).toEqual(['first-enter']);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(['first-enter', 'first-leave', 'second']);
  });
});
