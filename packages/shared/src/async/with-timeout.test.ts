import { describe, expect, test } from 'bun:test';
import { withTimeout } from './with-timeout';

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('withTimeout', () => {
  test('resolves with the promise value when it settles before the timeout', async () => {
    await expect(withTimeout(delay(5, 'ok'), 200)).resolves.toBe('ok');
  });

  test('rejects with a default message once the timeout elapses', async () => {
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 5)).rejects.toThrow('timed out after 5ms');
  });

  test('rejects with the given message', async () => {
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 5, 'custom timeout message')).rejects.toThrow(
      'custom timeout message'
    );
  });

  test('propagates rejection from the wrapped promise unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 200)).rejects.toThrow('boom');
  });

  test('clears its timer so it does not keep the process alive after resolving', async () => {
    const originalClearTimeout = global.clearTimeout;
    let cleared = false;
    // @ts-expect-error - 只是包一层探针，签名不完全一致不影响运行
    global.clearTimeout = (...args: Parameters<typeof clearTimeout>) => {
      cleared = true;
      return originalClearTimeout(...args);
    };
    try {
      await withTimeout(delay(1, 'ok'), 1000);
    } finally {
      global.clearTimeout = originalClearTimeout;
    }
    expect(cleared).toBe(true);
  });
});
