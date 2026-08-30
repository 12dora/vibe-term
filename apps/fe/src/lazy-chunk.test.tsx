// 按需 chunk 的失败兜底：import() 被拒时不能抛穿渲染，也不能永远停在 Suspense 骨架上，
// 而要落到路由页那张重试卡片上。无 DOM 测试环境，用 react-dom/server 静态渲染，
// 因此按 lazy 的两段式渲染：首帧出 fallback，等 promise settle 后再渲染一次。

import { describe, expect, test } from 'bun:test';
import { Suspense } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MAX_CHUNK_RETRIES, lazyChunk, retryChunkLoad } from './lazy-chunk';

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <Suspense fallback={<span data-testid="pending" />}>{node}</Suspense>
  );
}

describe('lazyChunk', () => {
  test('加载成功时渲染目标组件', async () => {
    const Ok = lazyChunk(async () => ({ label }: { label: string }) => (
      <p data-testid="ok">{label}</p>
    ));
    expect(render(<Ok label="hi" />)).toContain('data-testid="pending"');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const html = render(<Ok label="hi" />);
    expect(html).toContain('data-testid="ok"');
    expect(html).toContain('hi');
  });

  test('import 被拒时渲染重试卡片，而不是抛出或卡在骨架上', async () => {
    const Broken = lazyChunk<Record<string, never>>(() =>
      Promise.reject(new Error('Failed to fetch dynamically imported module'))
    );
    expect(render(<Broken />)).toContain('data-testid="pending"');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const html = render(<Broken />);
    expect(html).toContain('data-testid="page-load-error"');
    expect(html).toContain('data-testid="page-load-retry"');
    expect(html).not.toContain('data-testid="pending"');
  });

  test('重试只按失败计数、进行中不重复发起、达到上限才整页刷新', async () => {
    let pending: Array<{ resolve: (c: () => null) => void; reject: (e: Error) => void }> = [];
    const load = () =>
      new Promise<() => null>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    const loaded: unknown[] = [];
    let reloads = 0;
    const retry = () =>
      retryChunkLoad(
        load,
        (c) => loaded.push(c),
        () => reloads++
      );

    retry();
    retry();
    retry();
    expect(pending).toHaveLength(1);
    expect(reloads).toBe(0);

    for (let i = 0; i < MAX_CHUNK_RETRIES; i++) {
      pending[pending.length - 1].reject(new Error('chunk 404'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      retry();
    }
    expect(pending).toHaveLength(MAX_CHUNK_RETRIES);
    expect(reloads).toBe(1);

    pending = [];
    const ok = () =>
      new Promise<() => null>((resolve) => {
        pending.push({ resolve, reject: () => {} });
      });
    retryChunkLoad(
      ok,
      (c) => loaded.push(c),
      () => reloads++
    );
    pending[0].resolve(() => null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loaded).toHaveLength(1);
  });
});
