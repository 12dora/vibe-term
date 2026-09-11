// 回归：侧栏（桌面固定栏与手机抽屉共用同一棵子树）不许出现任何延迟读数。
//
// 延迟徽标已于 2.0.8 从侧栏移除，只留在设备页头部那一枚。但用户手机上仍然看得见——真因是
// Service Worker 一直回放装机那一代的应用壳（见 src/sw/sw-update.ts），并非代码回潮。
// 这条用例把「侧栏没有 ms 读数」钉死：有人再往侧栏加延迟展示时，先被这里拦住。
//
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 app-sidebar-footer 测试同一套做法）；
// 覆盖到的是标题行、分页与底部入口——设备列表在静态渲染下拿不到数据，本来就是空的。

import { describe, expect, mock, test } from 'bun:test';
import type { MeshNode } from '@vibeterm/api-client/auth/index';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import type { ReactNode } from 'react';

installWindowStorage();

// `matches` 即「桌面端」：两种视口都要跑一遍。
let desktopViewport = true;
(globalThis.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: desktopViewport,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

// 手机抽屉的真实 SheetContent 渲染在 base-ui 的 portal 里，静态渲染取不到；换成原地渲染
// children 的替身，抽屉里那棵子树才进得了标记（同 mobile-sidebar-drawer 测试）。
const realSheet = (await import('@vibeterm/ui/sheet')) as unknown as Record<string, unknown>;
mock.module('@vibeterm/ui/sheet', () => ({
  ...realSheet,
  SheetContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { RuntimeProvider } = await import('@vibeterm/stores/react');
const { SidebarProvider } = await import('@vibeterm/ui/sidebar');
const { appNodeRuntimes } = await import('@/node/node-runtimes');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('@/node/mesh-nodes');
const { GlobalDeviceProvider } = await import('@/components/global-device-provider');
const { AppSidebar } = await import('./app-sidebar');

const REMOTE_NODE_ID = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';

/** 每条链路都带上读数：真有残留的延迟展示，渲染结果里就一定看得见这些数字。 */
function seedNodes(): void {
  resetMeshNodesStateForTest();
  setMeshNodesStateForTest({
    entryNodeId: 'entry',
    nodes: [
      {
        id: REMOTE_NODE_ID,
        name: '书房',
        online: true,
        loggedIn: true,
        reach: 'wan',
        transport: 'ws-secure',
        rttMs: 137,
        inventory: null,
      } as MeshNode,
    ],
  });
  appNodeRuntimes.get('self').runtime.stores.tmux.setState({
    wsLatencyMs: 246,
    wsLatencyRawMs: 246,
    deviceLatencySupported: true,
    deviceLatency: {
      'dev-1': {
        rttMs: 83,
        rawMs: 83,
        hop: 'local',
        sampledAt: Date.now(),
        receivedAt: Date.now(),
      },
    },
  });
}

function render(desktop: boolean): string {
  desktopViewport = desktop;
  seedNodes();
  const runtime = appNodeRuntimes.get('self').runtime;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
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
}

/** 只看用户读得到的文字：class 名里的 `duration-…` 之类不算。 */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

describe('侧栏不展示延迟读数', () => {
  test('桌面固定栏里没有任何 ms 读数', () => {
    const html = render(true);
    // 先确认确实渲染出了侧栏本体，否则「没有 ms」只是空渲染的假象
    expect(html).toContain('data-testid="sidebar-connect-devices"');
    const text = visibleText(html);
    expect(text).not.toMatch(/\d+\s*ms/);
    expect(text).not.toContain('137');
    expect(text).not.toContain('246');
  });

  test('手机抽屉（同一棵子树）同样没有', () => {
    const html = render(false);
    expect(html).toContain('data-testid="sidebar-connect-devices"');
    const text = visibleText(html);
    expect(text).not.toMatch(/\d+\s*ms/);
  });
});
