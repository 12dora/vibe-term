// 侧栏底部入口：「接入更多设备」（右侧滑出面板）、「管理设备」与（mesh 下）「一键登录」同排等分，样式同为 SidebarMenuButton。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 sidebar-title 测试同一套做法）。

import { afterEach, describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

(globalThis.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { RuntimeProvider } = await import('@vibeterm/stores/react');
const { SidebarProvider } = await import('@vibeterm/ui/sidebar');
const { appNodeRuntimes } = await import('@/node/node-runtimes');
const { GlobalDeviceProvider } = await import('@/components/global-device-provider');
const { AppSidebar } = await import('./app-sidebar');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('@/node/mesh-nodes');

function render(): string {
  const runtime = appNodeRuntimes.get('self').runtime;
  // 静态渲染不跑 effect，不会真的发请求；这里只是补上 GlobalDeviceProvider 需要的 provider 链。
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RuntimeProvider runtime={runtime}>
        <QueryClientProvider client={queryClient}>
          <GlobalDeviceProvider>
            <SidebarProvider>
              <AppSidebar />
            </SidebarProvider>
          </GlobalDeviceProvider>
        </QueryClientProvider>
      </RuntimeProvider>
    </MemoryRouter>
  );
  return html;
}

describe('AppSidebar 底部导航', () => {
  afterEach(() => resetMeshNodesStateForTest());

  test('「接入更多设备」入口指向当前页的 connect 面板，且带无障碍标签', () => {
    const html = render();
    expect(html).toContain('data-testid="sidebar-connect-devices"');
    expect(html).toContain('href="/?panel=connect"');
    expect(html).toContain('aria-label="nav.connectDevices"');
  });

  test('「管理设备」入口仍在，两者同为 SidebarMenuButton 并排一行，标签为短标签、aria-label 为完整标题', () => {
    const html = render();
    expect(html).toContain('href="/devices"');
    expect(html).toContain('aria-label="nav.manageDevices"');
    expect(html).toContain('>nav.manageDevicesShort</span>');
    expect(html).toContain('>nav.connectDevicesShort</span>');
    const buttons = html.split('data-slot="sidebar-menu-button"').length - 1;
    expect(buttons).toBe(2);
    expect(html.split('data-slot="sidebar-menu"').length - 1).toBe(1);
  });

  test('standalone / 模式未落定时不出现「一键登录」', () => {
    expect(render()).not.toContain('data-testid="sidebar-login-code"');
    setMeshNodesStateForTest({
      mode: { mode: 'none' } as never,
      modeLoaded: true,
    });
    expect(render()).not.toContain('data-testid="sidebar-login-code"');
  });

  test('mesh 且凭据就绪时底部同一行多一个「一键登录」按钮（非链接，短标签）', () => {
    setMeshNodesStateForTest({
      mode: { mode: 'mesh', uid: 'u', kdfParams: {} } as never,
      modeLoaded: true,
    });
    const html = render();
    expect(html).toContain('data-testid="sidebar-login-code"');
    expect(html).toContain('aria-label="nav.loginCode"');
    const button = html.match(/<button[^>]*data-testid="sidebar-login-code"[^>]*>/)?.[0] ?? '';
    expect(button).toContain('type="button"');
    expect(html).toContain('>nav.loginCodeShort</span>');
    expect(html.split('data-slot="sidebar-menu-button"').length - 1).toBe(3);
    // 三个入口共用同一个 SidebarMenu（同一行）
    expect(html.split('data-slot="sidebar-menu"').length - 1).toBe(1);
  });
});
