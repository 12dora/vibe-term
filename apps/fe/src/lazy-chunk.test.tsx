// 按需 chunk 的失败兜底：import() 被拒时不能抛穿渲染，也不能永远停在 Suspense 骨架上，
// 而要落到路由页那张重试卡片上。无 DOM 测试环境，用 react-dom/server 静态渲染，
// 因此按 lazy 的两段式渲染：首帧出 fallback，等 promise settle 后再渲染一次。

import { describe, expect, test } from 'bun:test';
import { Suspense } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { lazyChunk } from './lazy-chunk';

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
});
