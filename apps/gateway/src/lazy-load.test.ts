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

  test('settled waits for an in-flight load and swallows failures', async () => {
    let release: (value: { id: number }) => void = () => {};
    const loader = createMemoizedLoader(
      () =>
        new Promise<{ id: number }>((resolve) => {
          release = resolve;
        })
    );
    expect(await loader.settled()).toBeUndefined();
    const loading = loader.load();
    const settled = loader.settled();
    release({ id: 7 });
    expect(await settled).toEqual({ id: 7 });
    expect(await loading).toEqual({ id: 7 });

    const failing = createMemoizedLoader(async () => {
      throw new Error('boom');
    });
    const attempt = failing.load().catch(() => undefined);
    expect(await failing.settled()).toBeUndefined();
    await attempt;
  });
});
