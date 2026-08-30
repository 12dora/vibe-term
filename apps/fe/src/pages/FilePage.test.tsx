// FilePage 的媒体 / raw URL 必须带当前 node 前缀（非 self 时不能落到 entry 的 /api/files/raw）。
// 无 DOM 环境，用 react-dom/server 静态渲染；重组件与查询层按需 mock。

import { describe, expect, mock, test } from 'bun:test';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

let statResponse: Record<string, unknown> = {};

class FakeQueryClient {}

mock.module('@tanstack/react-query', () => ({
  QueryClient: FakeQueryClient,
  useQuery: () => ({ data: statResponse, isLoading: false, isError: false, error: null }),
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
}));

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

mock.module('@tmex/panels/code-viewer', () => ({
  CodeViewer: () => null,
}));
mock.module('@tmex/panels/files', () => ({
  startTransferToast: () => ({
    leg: () => {},
    success: () => {},
    fail: () => {},
    cancel: () => {},
  }),
}));
mock.module('@tmex/panels/markdown', () => ({
  MarkdownPreview: ({ urlResolver }: { urlResolver: (p: string) => string }) => (
    <span data-markdown-image={urlResolver('img/a.png')} />
  ),
}));
mock.module('@/i18n', () => ({ default: { t: (key: string) => key } }));

const { renderToStaticMarkup } = await import('react-dom/server');
const { encodeFileRef } = await import('@tmex/stores');
const { RuntimeProvider } = await import('@tmex/stores/react');
const { appNodeRuntimes } = await import('./../node/node-runtimes');

const routeParams: { ref?: string } = {};
mock.module('react-router', () => ({ useParams: () => routeParams }));

const FilePage = (await import('./FilePage')).default;
const { PageActions } = await import('./FilePage');

function renderFilePage(nodeId: string, rootId: string, path: string, category: string): string {
  routeParams.ref = encodeFileRef(rootId, path);
  statResponse = { type: 'file', category, name: 'a.png', path, size: 10 };
  const runtime = appNodeRuntimes.get(nodeId).runtime;
  return renderToStaticMarkup(
    <RuntimeProvider runtime={runtime}>
      <FilePage />
    </RuntimeProvider>
  );
}

describe('FilePage 媒体 URL 带 node 前缀', () => {
  test('非 self node 的图片 src', () => {
    const markup = renderFilePage('0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a', 'r1', '/a.png', 'image');
    expect(markup).toContain(
      '/n/0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a/api/files/raw?rootId=r1&amp;path=%2Fa.png'
    );
  });

  test('self 的图片 src 与旧行为一致（无前缀）', () => {
    const markup = renderFilePage('self', 'r1', '/a.png', 'image');
    expect(markup).toContain('src="/api/files/raw?rootId=r1&amp;path=%2Fa.png"');
    expect(markup).not.toContain('/n/');
  });

  test('非 self node 的视频 / PDF src', () => {
    expect(renderFilePage('0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a', 'r1', '/v.mp4', 'video')).toContain(
      '/n/0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a/api/files/raw?rootId=r1&amp;path=%2Fv.mp4'
    );
    expect(renderFilePage('0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a', 'r1', '/d.pdf', 'pdf')).toContain(
      '/n/0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a/api/files/raw?rootId=r1&amp;path=%2Fd.pdf'
    );
  });

  test('markdown 图片 resolver 带 node 前缀', async () => {
    // MarkdownPreview 是 lazy 的：首帧只出 Suspense fallback，等模块解析完再渲染一次。
    const first = renderFilePage('0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a', 'r1', '/doc.md', 'markdown');
    expect(first).not.toContain('data-markdown-image');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const markup = renderFilePage('0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a', 'r1', '/doc.md', 'markdown');
    expect(markup).toContain(
      '/n/0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a/api/files/raw?rootId=r1&amp;path=img%2Fa.png'
    );
  });

  test('PageActions 的「打开原始文件」链接带 node 前缀', () => {
    const runtime = appNodeRuntimes.get('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b').runtime;
    const markup = renderToStaticMarkup(
      <RuntimeProvider runtime={runtime}>
        <PageActions ref={encodeFileRef('r1', '/a.png')} />
      </RuntimeProvider>
    );
    expect(markup).toContain(
      'href="/n/0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b/api/files/raw?rootId=r1&amp;path=%2Fa.png"'
    );
  });
});
