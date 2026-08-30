// getGhosttyBindings 缓存的是 promise 本身：一旦 wasm 加载/实例化/类型 JSON 解析失败，
// 被缓存的就是一个永远 rejected 的 promise，之后每次调用都拿到同一个失败，终端再也起不来。
// 用注入一次性失败的 instantiate 驱动真实加载路径，断言失败不进缓存、成功才进缓存。
import { describe, expect, test } from 'bun:test';

type GhosttyWasmModule = typeof import('./ghostty-wasm');

// 模块级缓存是文件私有的，每个用例必须拿一份独立副本
async function loadFreshModule(tag: string): Promise<GhosttyWasmModule> {
  return import(`./ghostty-wasm.ts?retry=${tag}-${Date.now()}`) as Promise<GhosttyWasmModule>;
}

async function withFailingInstantiate<T>(
  run: (calls: { count: number }) => Promise<T>
): Promise<T> {
  const realInstantiate = WebAssembly.instantiate;
  const calls = { count: 0 };
  (WebAssembly as { instantiate: unknown }).instantiate = async () => {
    calls.count += 1;
    throw new Error('injected instantiate failure');
  };

  try {
    return await run(calls);
  } finally {
    (WebAssembly as { instantiate: unknown }).instantiate = realInstantiate;
  }
}

describe('getGhosttyBindings failure caching', () => {
  test('should not cache a rejected load, so a later call retries and succeeds', async () => {
    const module = await loadFreshModule('recover');

    await withFailingInstantiate(async () => {
      await expect(module.getGhosttyBindings()).rejects.toThrow('injected instantiate failure');
    });

    const bindings = await module.getGhosttyBindings();
    expect(bindings).toBeInstanceOf(module.GhosttyBindings);
  });

  test('should keep caching the successful load', async () => {
    const module = await loadFreshModule('cache');

    const first = await module.getGhosttyBindings();
    const second = await module.getGhosttyBindings();

    expect(second).toBe(first);
  });

  test('should surface every failure while the loader keeps failing', async () => {
    const module = await loadFreshModule('repeat');

    await withFailingInstantiate(async (calls) => {
      await expect(module.getGhosttyBindings()).rejects.toThrow('injected instantiate failure');
      await expect(module.getGhosttyBindings()).rejects.toThrow('injected instantiate failure');
      expect(calls.count).toBe(2);
    });
  });
});
