import { describe, expect, test } from 'bun:test';
import { FILE_ROOTS_FETCH_CONCURRENCY, createConcurrencyGate } from './files-roots-fetch';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('createConcurrencyGate', () => {
  test('默认 roots 闸是 2', () => {
    expect(FILE_ROOTS_FETCH_CONCURRENCY).toBe(2);
  });

  test('超过上限的任务排队，前一个结束后才开工', async () => {
    const run = createConcurrencyGate(2);
    const started: string[] = [];
    const first = deferred<void>();
    const second = deferred<void>();
    const third = deferred<void>();

    const a = run(async () => {
      started.push('a');
      await first.promise;
      return 'a';
    });
    const b = run(async () => {
      started.push('b');
      await second.promise;
      return 'b';
    });
    const c = run(async () => {
      started.push('c');
      await third.promise;
      return 'c';
    });

    await Promise.resolve();
    expect(started).toEqual(['a', 'b']);

    first.resolve();
    expect(await a).toBe('a');
    await Promise.resolve();
    expect(started).toEqual(['a', 'b', 'c']);

    second.resolve();
    third.resolve();
    expect(await Promise.all([b, c])).toEqual(['b', 'c']);
  });

  test('失败也释放名额，后来者能开工', async () => {
    const run = createConcurrencyGate(1);
    const blocker = deferred<void>();
    const first = run(async () => {
      await blocker.promise;
      throw new Error('boom');
    });
    const second = run(async () => 'ok');

    blocker.resolve();
    await expect(first).rejects.toThrow('boom');
    expect(await second).toBe('ok');
  });
});
