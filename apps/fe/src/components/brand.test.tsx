// Brand：站点名兜底 / 自定义站点名 / 链接包裹 / 仅 logo。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 sidebar-title 测试同一套做法）。

import { describe, expect, test } from 'bun:test';
import type { SiteSettings } from '@tmex/shared';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { RuntimeProvider } = await import('@tmex/stores/react');
const { appNodeRuntimes } = await import('@/node/node-runtimes');
const { Brand, BRAND_LOGO_SRC, PRODUCT_NAME } = await import('./brand');

function renderStandalone(node: React.ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

function renderWithSiteName(siteName: string, node: React.ReactElement): string {
  const runtime = appNodeRuntimes.get('self').runtime;
  const previous = runtime.stores.site.getState().settings;
  runtime.stores.site.setState({ settings: { siteName } as SiteSettings });
  try {
    return renderToStaticMarkup(
      <MemoryRouter>
        <RuntimeProvider runtime={runtime}>{node}</RuntimeProvider>
      </MemoryRouter>
    );
  } finally {
    runtime.stores.site.setState({ settings: previous });
  }
}

describe('Brand', () => {
  test('没有 runtime 时回落产品名，并渲染 logo', () => {
    const html = renderStandalone(<Brand />);
    expect(html).toContain(`>${PRODUCT_NAME}<`);
    expect(html).toContain(`src="${BRAND_LOGO_SRC}"`);
    expect(html).toContain('data-testid="brand"');
  });

  test('站点设置里的 siteName 优先于产品名', () => {
    const html = renderWithSiteName('My Cluster', <Brand />);
    expect(html).toContain('>My Cluster<');
    expect(html).not.toContain(`>${PRODUCT_NAME}<`);
  });

  test('linkTo 把整块包成链接', () => {
    const html = renderStandalone(<Brand linkTo="/" />);
    expect(html).toContain('<a');
    expect(html).toContain('href="/"');
  });

  test('不传 linkTo 时不产生链接', () => {
    const html = renderStandalone(<Brand />);
    expect(html).not.toContain('<a');
  });

  test('showName=false 只留 logo', () => {
    const html = renderStandalone(<Brand showName={false} />);
    expect(html).toContain(`src="${BRAND_LOGO_SRC}"`);
    expect(html).not.toContain(`>${PRODUCT_NAME}<`);
  });
});
