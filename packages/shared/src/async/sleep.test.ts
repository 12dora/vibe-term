import { describe, expect, test } from 'bun:test';
import { sleep, sleepOrAbort } from './sleep';

describe('sleep', () => {
  test('resolves after the requested delay', async () => {
    const started = Date.now();
    await sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});

describe('sleepOrAbort', () => {
  test('returns true when the full delay elapses', async () => {
    await expect(sleepOrAbort(5)).resolves.toBe(true);
    await expect(sleepOrAbort(5, null)).resolves.toBe(true);
  });

  test('returns false immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await expect(sleepOrAbort(1000, controller.signal)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });

  test('returns false when aborted mid-flight and never rejects', async () => {
    const controller = new AbortController();
    const pending = sleepOrAbort(1000, controller.signal);
    setTimeout(() => controller.abort(new Error('stop')), 5);
    await expect(pending).resolves.toBe(false);
  });

  test('drops the abort listener once the delay completes', async () => {
    const controller = new AbortController();
    let removed = 0;
    const original = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = ((...args: Parameters<typeof original>): void => {
      removed += 1;
      original(...args);
    }) as typeof controller.signal.removeEventListener;

    await expect(sleepOrAbort(5, controller.signal)).resolves.toBe(true);
    expect(removed).toBe(1);
  });
});
