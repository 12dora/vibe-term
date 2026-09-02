// 侧滑面板的内容区：按需 chunk 的两段式渲染（先骨架、后内容），外面裹的是 panel 形态的错误边界。
// 宿主本体渲染在 Base UI 的 portal 里，静态渲染取不到标记，所以只测抽出来的内容区。

import { describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

// SidebarProvider（指引里的 NavLink 依赖）在构造 state 时就读 matchMedia。
(globalThis.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { RuntimeProvider } = await import('@tmex/stores/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { SidebarProvider } = await import('@tmex/ui/sidebar');
const { appNodeRuntimes } = await import('@/node/node-runtimes');
const { SidePanelBody } = await import('./side-panel-host');

const PENDING = 'data-testid="side-panel-pending"';

function render(node: React.ReactNode): string {
  const runtime = appNodeRuntimes.get('self').runtime;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <MemoryRouter>
      <RuntimeProvider runtime={runtime}>
        <QueryClientProvider client={queryClient}>
          <SidebarProvider>{node}</SidebarProvider>
        </QueryClientProvider>
      </RuntimeProvider>
    </MemoryRouter>
  );
}

/** lazy 的 promise 在首帧才建立，chunk 到位要几个 tick：轮询到骨架消失为止。 */
async function renderLoaded(node: React.ReactNode): Promise<string> {
  let html = render(node);
  for (let i = 0; i < 100 && html.includes(PENDING); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    html = render(node);
  }
  return html;
}

describe('SidePanelBody', () => {
  test('chunk 未到时给骨架，到了之后渲染接入指引', async () => {
    const first = render(<SidePanelBody panel="connect" onClose={() => undefined} />);
    expect(first).toContain(PENDING);
    expect(first).not.toContain('data-testid="panel-error"');

    const loaded = await renderLoaded(<SidePanelBody panel="connect" onClose={() => undefined} />);
    expect(loaded).toContain('data-testid="connect-devices-panel"');
    expect(loaded).not.toContain(PENDING);
    expect(loaded).not.toContain('data-testid="panel-error"');
  });

  test('账号安全面板同样按需加载，加载完不落在错误卡片上', async () => {
    const loaded = await renderLoaded(<SidePanelBody panel="security" onClose={() => undefined} />);
    expect(loaded).not.toContain(PENDING);
    expect(loaded).not.toContain('data-testid="panel-error"');
  });
});
