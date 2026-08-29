// 侧边栏标题行：mesh 时多一个「节点」入口，standalone / 未加载时没有。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 sidebar-device-list 测试同一套做法）。

import { describe, expect, test } from 'bun:test';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

// SidebarProvider 在构造 state 时就读 matchMedia；这里只需要一个稳定的桌面端读数。
(globalThis.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { RuntimeProvider } = await import('@tmex/stores/react');
const { SidebarProvider } = await import('@tmex/ui/sidebar');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('@/node/mesh-nodes');
const { appNodeRuntimes } = await import('../../../node/node-runtimes');
const { BRAND_LOGO_SRC, PRODUCT_NAME } = await import('../../brand');
const { SidebarTitle } = await import('./sidebar-title');

const MESH_MODE: AuthModeResponse = {
  mode: 'mesh',
  nodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
  uid: 'user-1',
  username: 'alice',
  kdfParams: null,
  passkeysForThisOrigin: false,
  passkeyAvailable: false,
};

function render(mode: AuthModeResponse | null): string {
  resetMeshNodesStateForTest();
  if (mode) setMeshNodesStateForTest({ mode, modeLoaded: true, entryNodeId: mode.nodeId });
  const runtime = appNodeRuntimes.get('self').runtime;
  return renderToStaticMarkup(
    <MemoryRouter>
      <RuntimeProvider runtime={runtime}>
        <SidebarProvider>
          <SidebarTitle />
        </SidebarProvider>
      </RuntimeProvider>
    </MemoryRouter>
  );
}

describe('SidebarTitle', () => {
  test('渲染品牌块（logo + 站点名），链接回首页', () => {
    const html = render(MESH_MODE);
    expect(html).toContain('data-testid="brand"');
    expect(html).toContain(`src="${BRAND_LOGO_SRC}"`);
    expect(html).toContain(`>${PRODUCT_NAME}<`);
    expect(html).toContain('href="/"');
  });

  test('mesh 模式渲染节点入口，指向 /nodes', () => {
    const html = render(MESH_MODE);
    expect(html).toContain('data-testid="sidebar-nodes"');
    expect(html).toContain('href="/nodes"');
    expect(html).toContain('data-testid="sidebar-settings"');
  });

  test('standalone（mode:none）不渲染节点入口，设置入口仍在', () => {
    const html = render({ ...MESH_MODE, mode: 'none' });
    expect(html).not.toContain('data-testid="sidebar-nodes"');
    expect(html).not.toContain('href="/nodes"');
    expect(html).toContain('data-testid="sidebar-settings"');
  });

  test('mode 未加载完成时不渲染节点入口（不能先闪一下再消失）', () => {
    const html = render(null);
    expect(html).not.toContain('data-testid="sidebar-nodes"');
  });
});
