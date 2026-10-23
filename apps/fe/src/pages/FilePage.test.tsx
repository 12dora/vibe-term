// FilePage 的媒体 / raw URL 必须带当前 node 前缀（非 self 时不能落到 entry 的 /api/files/raw）。
// 无 DOM 环境，用 react-dom/server 静态渲染；重组件与查询层按需 mock。

import { describe, expect, mock, test } from 'bun:test';
import * as actualReactQuery from '@tanstack/react-query';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';

installWindowStorage();

let statResponse: Record<string, unknown> = {};
let listResponse: Record<string, unknown> = { entries: [] };
// stat 查询的状态：默认已就绪；加载 / 失败用例临时改写
let statState: { isLoading: boolean; isError: boolean; data: unknown } | null = null;

// mock.module 是进程级的：同一次 bun test 里后面加载的文件也会拿到这份模块，只覆盖用到的三个
// 导出会让别的测试报「Export named 'QueryClientProvider' not found」（Linux 上文件顺序不同就会触发）。
mock.module('@tanstack/react-query', () => ({
  ...actualReactQuery,
  // 预览页有两个查询：stat（['files','stat',…]）与同目录列表（['files','list',…]）
  useQuery: (options: { queryKey: readonly unknown[] }) =>
    options.queryKey[1] === 'list'
      ? { data: listResponse, isLoading: false, isError: false, error: null }
      : {
          data: statResponse,
          isLoading: false,
          isError: false,
          error: null,
          ...statState,
        },
  useQueryClient: () => ({
    invalidateQueries: () => Promise.resolve(),
    prefetchQuery: () => Promise.resolve(),
  }),
}));

mock.module('@vibeterm/panels/code-viewer', () => ({
  CodeViewer: () => null,
}));
mock.module('@vibeterm/panels/markdown', () => ({
  MarkdownPreview: ({ urlResolver }: { urlResolver: (p: string) => string }) => (
    <span data-markdown-image={urlResolver('img/a.png')} />
  ),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { encodeFileRef } = await import('@vibeterm/stores');
const { RuntimeProvider } = await import('@vibeterm/stores/react');
const { appNodeRuntimes } = await import('./../node/node-runtimes');

// 独立空实例：t 回 key；不 mock react-i18next，免得进程级 mock 泄漏给后续测试文件。
const i18n = i18next.createInstance();
await i18n.init({ lng: 'en_US', resources: {}, react: { useSuspense: false } });

const routeParams: { ref?: string } = {};
mock.module('react-router', () => ({ useParams: () => routeParams }));

const FilePage = (await import('./FilePage')).default;
const { PageActions, PageTitle } = await import('./FilePage');

function renderFilePage(nodeId: string, rootId: string, path: string, category: string): string {
  routeParams.ref = encodeFileRef(rootId, path);
  statResponse = { type: 'file', category, name: 'a.png', path, size: 10 };
  const runtime = appNodeRuntimes.get(nodeId).runtime;
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <RuntimeProvider runtime={runtime}>
        <FilePage />
      </RuntimeProvider>
    </I18nextProvider>
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
      <I18nextProvider i18n={i18n}>
        <RuntimeProvider runtime={runtime}>
          <PageActions ref={encodeFileRef('r1', '/a.png')} />
        </RuntimeProvider>
      </I18nextProvider>
    );
    expect(markup).toContain(
      'href="/n/0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b/api/files/raw?rootId=r1&amp;path=%2Fa.png"'
    );
  });
});

function listEntry(name: string, category = 'image', type = 'file') {
  return {
    name,
    path: `/pics/${name}`,
    type,
    category,
    size: 10,
    modifiedAt: null,
    isSymlink: false,
  };
}

function renderPreview(current: string, entries: unknown[], category = 'image'): string {
  listResponse = { entries };
  return renderFilePage('self', 'r1', `/pics/${current}`, category);
}

function renderActions(current: string, entries: unknown[], category: string): string {
  listResponse = { entries };
  statResponse = { type: 'file', category, name: current, path: `/pics/${current}`, size: 10 };
  const runtime = appNodeRuntimes.get('self').runtime;
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <RuntimeProvider runtime={runtime}>
        <PageActions ref={encodeFileRef('r1', `/pics/${current}`)} />
      </RuntimeProvider>
    </I18nextProvider>
  );
}

const PICS = [listEntry('a.png'), listEntry('b.png'), listEntry('c.png')];

describe('FilePage 上一个 / 下一个（图片 / PDF / 音视频：边缘悬浮按钮）', () => {
  test('中间的文件两侧都有按钮', () => {
    const markup = renderPreview('b.png', PICS);
    expect(markup).toContain('data-testid="file-prev"');
    expect(markup).toContain('data-testid="file-next"');
    expect(markup).toContain('aria-label="file.previous"');
    expect(markup).toContain('aria-label="file.next"');
  });

  test('首 / 尾不循环：没有上一个或下一个就不渲染对应按钮', () => {
    const first = renderPreview('a.png', PICS);
    expect(first).not.toContain('file-prev');
    expect(first).toContain('file-next');
    const last = renderPreview('c.png', PICS);
    expect(last).toContain('file-prev');
    expect(last).not.toContain('file-next');
  });

  test('目录里只有它自己、或列表里找不到当前文件：没有按钮', () => {
    const only = renderPreview('a.png', [listEntry('a.png')]);
    expect(only).not.toContain('file-prev');
    expect(only).not.toContain('file-next');
    const missing = renderPreview('gone.png', PICS);
    expect(missing).not.toContain('file-prev');
    expect(missing).not.toContain('file-next');
  });

  test('邻居的 stat 加载中 / 失败时按钮仍在（外框不卸载）', () => {
    statState = { isLoading: true, isError: false, data: undefined };
    const loading = renderPreview('b.png', PICS);
    expect(loading).toContain('common.loading');
    expect(loading).toContain('file-prev');
    expect(loading).toContain('file-next');
    statState = { isLoading: false, isError: true, data: undefined };
    const failed = renderPreview('b.png', PICS);
    expect(failed).toContain('file-prev');
    expect(failed).toContain('file-next');
    statState = null;
  });
});

describe('文本类预览的上一个 / 下一个在页头', () => {
  const TEXTS = [
    listEntry('a.zip', 'archive'),
    listEntry('b.txt', 'text'),
    listEntry('sub', 'directory', 'dir'),
    listEntry('c.md', 'markdown'),
    listEntry('d.bin', 'binary'),
  ];

  test('正文区不盖悬浮按钮，页头在刷新左侧给出按钮；目录与不可预览文件被跳过', () => {
    const page = renderPreview('b.txt', TEXTS, 'text');
    expect(page).not.toContain('file-prev');
    expect(page).not.toContain('file-next');
    const actions = renderActions('b.txt', TEXTS, 'text');
    expect(actions).not.toContain('file-prev');
    expect(actions).toContain('data-testid="file-next"');
    expect(actions.indexOf('file-next')).toBeLessThan(actions.indexOf('file-refresh'));
  });

  test('图片预览的页头没有这组按钮（用边缘按钮）', () => {
    const actions = renderActions('b.png', PICS, 'image');
    expect(actions).not.toContain('file-prev');
    expect(actions).not.toContain('file-next');
  });
});

describe('预览页顶栏返回文件管理器', () => {
  test('标题前有返回按钮，文件名仍在', () => {
    const runtime = appNodeRuntimes.get('self').runtime;
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <RuntimeProvider runtime={runtime}>
          <PageTitle ref={encodeFileRef('r1', '/pics/a.png')} />
        </RuntimeProvider>
      </I18nextProvider>
    );
    expect(markup).toContain('data-testid="file-back"');
    expect(markup).toContain('aria-label="file.back"');
    expect(markup.indexOf('file-back')).toBeLessThan(markup.indexOf('a.png'));
  });

  test('ref 无效时标题为空', () => {
    const runtime = appNodeRuntimes.get('self').runtime;
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <RuntimeProvider runtime={runtime}>
          <PageTitle ref="%%%" />
        </RuntimeProvider>
      </I18nextProvider>
    );
    expect(markup).toBe('');
  });
});
