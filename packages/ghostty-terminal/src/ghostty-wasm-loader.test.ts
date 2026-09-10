// wasm 加载：浏览器侧只有服务端确实下发 application/wasm 时才走 instantiateStreaming
// （边下边编译，省掉一次 555 KB 的整包 arrayBuffer）；MIME 不对或流式失败必须无声退回整包路径。

import { afterEach, describe, expect, test } from 'bun:test';
import { instantiateWasmSource } from './ghostty-wasm-loader';

const SOURCE = 'https://vibeterm.example/assets/ghostty-vt-abc12345.wasm';
const FAKE_RESULT = {
  instance: { exports: {} },
  module: {},
} as unknown as WebAssembly.WebAssemblyInstantiatedSource;

interface Harness {
  fetches: string[];
  streamed: number;
  buffered: number;
}

const realFetch = globalThis.fetch;
const realInstantiate = WebAssembly.instantiate;
const realStreaming = WebAssembly.instantiateStreaming;

afterEach(() => {
  globalThis.fetch = realFetch;
  (WebAssembly as { instantiate: unknown }).instantiate = realInstantiate;
  (WebAssembly as { instantiateStreaming: unknown }).instantiateStreaming = realStreaming;
});

function install(options: {
  contentType?: string;
  status?: number;
  streamingFails?: boolean;
}): Harness {
  const harness: Harness = { fetches: [], streamed: 0, buffered: 0 };
  globalThis.fetch = ((input: string) => {
    harness.fetches.push(String(input));
    const headers = new Headers();
    if (options.contentType) headers.set('Content-Type', options.contentType);
    return Promise.resolve(
      new Response(new Uint8Array([0, 97, 115, 109]), { status: options.status ?? 200, headers })
    );
  }) as unknown as typeof fetch;
  (WebAssembly as { instantiateStreaming: unknown }).instantiateStreaming = async () => {
    harness.streamed += 1;
    if (options.streamingFails) throw new Error('streaming compile failed');
    return FAKE_RESULT;
  };
  (WebAssembly as { instantiate: unknown }).instantiate = async () => {
    harness.buffered += 1;
    return FAKE_RESULT;
  };
  return harness;
}

describe('instantiateWasmSource', () => {
  test('application/wasm 走流式实例化，只取一次网络', async () => {
    const harness = install({ contentType: 'application/wasm' });
    await instantiateWasmSource(SOURCE, {});
    expect(harness.streamed).toBe(1);
    expect(harness.buffered).toBe(0);
    expect(harness.fetches).toEqual([SOURCE]);
  });

  test('带 charset 参数的 application/wasm 同样走流式', async () => {
    const harness = install({ contentType: 'application/wasm; charset=utf-8' });
    await instantiateWasmSource(SOURCE, {});
    expect(harness.streamed).toBe(1);
  });

  test('MIME 不是 application/wasm 时退回整包实例化', async () => {
    const harness = install({ contentType: 'application/octet-stream' });
    await instantiateWasmSource(SOURCE, {});
    expect(harness.streamed).toBe(0);
    expect(harness.buffered).toBe(1);
    expect(harness.fetches).toEqual([SOURCE]);
  });

  test('缺 Content-Type 时退回整包实例化', async () => {
    const harness = install({});
    await instantiateWasmSource(SOURCE, {});
    expect(harness.streamed).toBe(0);
    expect(harness.buffered).toBe(1);
  });

  test('流式失败时整包重取一次兜底', async () => {
    const harness = install({ contentType: 'application/wasm', streamingFails: true });
    await instantiateWasmSource(SOURCE, {});
    expect(harness.streamed).toBe(1);
    expect(harness.buffered).toBe(1);
    expect(harness.fetches).toEqual([SOURCE, SOURCE]);
  });

  test('非 2xx 响应抛出带状态码的错误，不进入实例化', async () => {
    const harness = install({ contentType: 'application/wasm', status: 404 });
    await expect(instantiateWasmSource(SOURCE, {})).rejects.toThrow('failed to load ghostty wasm');
    expect(harness.streamed).toBe(0);
    expect(harness.buffered).toBe(0);
  });
});
