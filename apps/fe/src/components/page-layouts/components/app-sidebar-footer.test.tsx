// 侧栏底部两个入口：「接入更多设备」（右侧滑出面板）与「管理设备」并排，样式同为 SidebarMenuButton。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 sidebar-title 测试同一套做法）。

import { describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

(globalThis.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { RuntimeProvider } = await import('@tmex/stores/react');
const { SidebarProvider } = await import('@tmex/ui/sidebar');
const { appNodeRuntimes } = await import('@/node/node-runtimes');
const { GlobalDeviceProvider } = await import('@/components/global-device-provider');
const { AppSidebar } = await import('./app-sidebar');

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
  test('「接入更多设备」入口指向当前页的 connect 面板，且带无障碍标签', () => {
    const html = render();
    expect(html).toContain('data-testid="sidebar-connect-devices"');
    expect(html).toContain('href="/?panel=connect"');
    expect(html).toContain('aria-label="nav.connectDevices"');
  });

  test('「管理设备」入口仍在，两者同为 SidebarMenuButton 并排一行', () => {
    const html = render();
    expect(html).toContain('href="/devices"');
    expect(html).toContain('aria-label="nav.manageDevices"');
    const buttons = html.split('data-slot="sidebar-menu-button"').length - 1;
    expect(buttons).toBe(2);
    expect(html).toContain('data-slot="sidebar-menu"');
  });
});
