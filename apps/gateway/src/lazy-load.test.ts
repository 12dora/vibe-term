import { describe, expect, test } from 'bun:test';
import { createMemoizedLoader } from './lazy-load';

describe('createMemoizedLoader', () => {
  test('memoizes the resolved module and shares in-flight work', async () => {
    let calls = 0;
    const loader = createMemoizedLoader(async () => {
      calls += 1;
      await Promise.resolve();
      return { id: calls };
    });
    const [a, b] = await Promise.all([loader.load(), loader.load()]);
    expect(a).toBe(b);
    expect(a.id).toBe(1);
    expect(calls).toBe(1);
    expect(loader.peek()).toBe(a);
    expect(await loader.load()).toBe(a);
    expect(calls).toBe(1);
  });

  test('propagates importer errors and retries after failure', async () => {
    let calls = 0;
    const loader = createMemoizedLoader(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return { ok: true };
    });
    await expect(loader.load()).rejects.toThrow('boom');
    expect(loader.peek()).toBeUndefined();
    expect(await loader.load()).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  test('reset drops the cached module', async () => {
    let calls = 0;
    const loader = createMemoizedLoader(async () => {
      calls += 1;
      return { calls };
    });
    const first = await loader.load();
    loader.reset();
    const second = await loader.load();
    expect(first).not.toBe(second);
    expect(calls).toBe(2);
  });
});
