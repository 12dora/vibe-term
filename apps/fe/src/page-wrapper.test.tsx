// PageWrapper 顶栏：无侧栏页面（/login）左上角必须有品牌，
// 有侧栏时左上角是侧栏开关而不是品牌。无 DOM 测试环境，用 react-dom/server 静态渲染。

import { describe, expect, test } from 'bun:test';
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
const { SidebarProvider } = await import('@tmex/ui/sidebar');
const { BRAND_LOGO_SRC } = await import('@/components/brand');
const { PageWrapper } = await import('./page-wrapper');
const { clearPageModuleCache, requestPageModule } = await import('./use-page-module');

const moduleLoader = async () => ({});

describe('PageWrapper', () => {
  test('withSidebar=false 时顶栏渲染品牌，没有侧栏开关', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PageWrapper moduleLoader={moduleLoader} withSidebar={false} />
      </MemoryRouter>
    );
    expect(html).toContain('data-testid="brand"');
    expect(html).toContain(`src="${BRAND_LOGO_SRC}"`);
    expect(html).not.toContain('data-testid="mobile-sidebar-open"');
  });

  test('withSidebar=true 时顶栏是侧栏开关，不重复渲染品牌（品牌在侧栏里）', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SidebarProvider>
          <PageWrapper moduleLoader={moduleLoader} />
        </SidebarProvider>
      </MemoryRouter>
    );
    expect(html).toContain('data-testid="mobile-sidebar-open"');
    expect(html).not.toContain('data-testid="brand"');
  });

  test('侧栏开关带 aria-label 与说明气泡，桌面展开态说的是「收起」', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SidebarProvider>
          <PageWrapper moduleLoader={moduleLoader} />
        </SidebarProvider>
      </MemoryRouter>
    );
    expect(html).toContain('aria-label="nav.sidebarCollapse"');
    expect(html).toContain('data-slot="tooltip-trigger"');
  });
});

describe('PageWrapper 的重访', () => {
  const Page = () => <p data-testid="cached-page">page</p>;
  const PageTitle = () => <span>cached title</span>;
  const cachedLoader = async () => ({ default: Page, PageTitle });

  function render(): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <SidebarProvider>
          <PageWrapper moduleLoader={cachedLoader} />
        </SidebarProvider>
      </MemoryRouter>
    );
  }

  test('首访的第一帧仍是空的（模块还没落地）', () => {
    clearPageModuleCache();
    expect(render()).not.toContain('data-testid="cached-page"');
  });

  test('模块加载过之后，重挂的第一帧就是 ready，不再闪一帧 loading', async () => {
    clearPageModuleCache();
    await new Promise<void>((resolve) => {
      requestPageModule(cachedLoader, (state) => {
        if (state.status === 'ready') resolve();
      });
    });

    const html = render();
    expect(html).toContain('data-testid="cached-page"');
    expect(html).toContain('cached title');
    clearPageModuleCache();
  });
});
