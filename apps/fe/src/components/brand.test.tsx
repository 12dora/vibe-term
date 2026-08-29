// Brand：主标题恒为产品名，副标题是本机 node 名（mesh 取 entry 自身，standalone 退回站点名）。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 sidebar-title 测试同一套做法）。

import { afterEach, describe, expect, test } from 'bun:test';
import type { MeshNode } from '@tmex/api-client/auth/index';
import type { SiteSettings } from '@tmex/shared';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { RuntimeProvider } = await import('@tmex/stores/react');
const { appNodeRuntimes } = await import('@/node/node-runtimes');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('@/node/mesh-nodes');
const { Brand, BRAND_LOGO_SRC, PRODUCT_NAME } = await import('./brand');

function meshNode(id: string, name: string): MeshNode {
  return {
    id,
    name,
    publicKey: '',
    online: true,
    reach: 'lan',
    version: null,
    direct_capable: false,
    loggedIn: true,
  };
}

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

afterEach(() => {
  resetMeshNodesStateForTest();
});

describe('Brand', () => {
  test('没有 runtime 时只渲染产品名与 logo，不出副标题', () => {
    const html = renderStandalone(<Brand />);
    expect(html).toContain(`>${PRODUCT_NAME}<`);
    expect(html).toContain(`src="${BRAND_LOGO_SRC}"`);
    expect(html).toContain('data-testid="brand"');
    expect(html).not.toContain('data-testid="brand-node-name"');
  });

  test('主标题恒为产品名，副标题是 mesh 里 entry 自身的 node 名', () => {
    setMeshNodesStateForTest({
      entryNodeId: 'node-a',
      nodes: [meshNode('node-a', 'work-mac'), meshNode('node-b', 'other-box')],
    });
    const html = renderWithSiteName('My Cluster', <Brand />);
    expect(html).toContain(`data-testid="brand-name">${PRODUCT_NAME}<`);
    expect(html).toContain('data-testid="brand-node-name">work-mac<');
    expect(html).not.toContain('My Cluster');
  });

  test('standalone（没有 mesh node 名）时副标题退回站点名', () => {
    const html = renderWithSiteName('My Cluster', <Brand />);
    expect(html).toContain(`data-testid="brand-name">${PRODUCT_NAME}<`);
    expect(html).toContain('data-testid="brand-node-name">My Cluster<');
  });

  test('站点名与产品名相同时不渲染副标题', () => {
    const html = renderWithSiteName(PRODUCT_NAME, <Brand />);
    expect(html).not.toContain('data-testid="brand-node-name"');
  });

  test('size=sm 保持单行：只有产品名', () => {
    setMeshNodesStateForTest({
      entryNodeId: 'node-a',
      nodes: [meshNode('node-a', 'work-mac')],
    });
    const html = renderStandalone(<Brand size="sm" />);
    expect(html).toContain(`data-testid="brand-name">${PRODUCT_NAME}<`);
    expect(html).not.toContain('work-mac');
  });

  test('title 同时带上产品名与本机 node 名', () => {
    setMeshNodesStateForTest({
      entryNodeId: 'node-a',
      nodes: [meshNode('node-a', 'work-mac')],
    });
    const html = renderStandalone(<Brand />);
    expect(html).toContain(`title="${PRODUCT_NAME} · work-mac"`);
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
