import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { SynchronizedOutputFallback } from './synchronized-output-fallback';

type Pending = { run: () => void; delay: number; cleared: boolean };

describe('SynchronizedOutputFallback', () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let pending: Pending[] = [];

  beforeEach(() => {
    pending = [];
    globalThis.setTimeout = ((run: () => void, delay: number) => {
      const entry: Pending = { run, delay, cleared: false };
      pending.push(entry);
      return entry;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle: Pending) => {
      handle.cleared = true;
    }) as unknown as typeof clearTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  test('arm 只挂一个计时器，到点触发一次并允许再次挂起', () => {
    const fire = mock(() => {});
    const fallback = new SynchronizedOutputFallback(fire);

    fallback.arm();
    fallback.arm();
    expect(pending).toHaveLength(1);
    expect(pending[0].delay).toBe(150);

    pending[0].run();
    expect(fire).toHaveBeenCalledTimes(1);

    fallback.arm();
    expect(pending).toHaveLength(2);
  });

  test('cancel 清掉未触发的计时器，重复 cancel 是空操作', () => {
    const fire = mock(() => {});
    const fallback = new SynchronizedOutputFallback(fire);

    fallback.cancel();
    fallback.arm();
    fallback.cancel();
    fallback.cancel();
    expect(pending[0].cleared).toBeTrue();

    fallback.arm();
    expect(pending).toHaveLength(2);
    expect(pending[1].cleared).toBeFalse();
  });
});
