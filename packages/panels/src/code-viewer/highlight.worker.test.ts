// worker 端到端：Bun 的 Worker 与浏览器同为 module worker，能真跑一遍
// 「按需 import 语言 -> registerLanguage -> 回包」这条链。
import { afterAll, describe, expect, test } from 'bun:test';
import type { HighlightWorkerResponse } from './highlight-protocol';

const worker = new Worker(new URL('./highlight.worker.ts', import.meta.url).href, {
  type: 'module',
});
const inflight = new Map<number, (response: HighlightWorkerResponse) => void>();
worker.addEventListener('message', (event: MessageEvent<HighlightWorkerResponse>) => {
  inflight.get(event.data.id)?.(event.data);
});

afterAll(() => worker.terminate());

function highlight(id: number, code: string, fileName: string): Promise<HighlightWorkerResponse> {
  return new Promise((resolve) => {
    inflight.set(id, resolve);
    worker.postMessage({ id, code, fileName });
  });
}

describe('高亮 worker', () => {
  test('按扩展名回高亮 HTML，id 原样带回', async () => {
    const response = await highlight(1, 'const a = 1;', 'a.ts');
    expect(response.id).toBe(1);
    expect(response.html).toContain('hljs-keyword');
  });

  test('未知扩展名走自动识别子集', async () => {
    expect((await highlight(2, 'const a = 1;', 'notes.unknownext')).html).toContain('hljs-');
  });

  test('并发请求各自回各自的 id', async () => {
    const [ts, py] = await Promise.all([
      highlight(3, 'let x: number = 1;', 'x.ts'),
      highlight(4, 'def f():\n  pass\n', 'f.py'),
    ]);
    expect(ts.id).toBe(3);
    expect(ts.html).toContain('hljs-keyword');
    expect(py.id).toBe(4);
    expect(py.html).toContain('hljs-keyword');
  });

  test('超过 512 KiB 的已知语言不高亮', async () => {
    const response = await highlight(5, 'const a = 1;\n'.repeat(50_000), 'big.ts');
    expect(response.html).toBeNull();
  });
});
