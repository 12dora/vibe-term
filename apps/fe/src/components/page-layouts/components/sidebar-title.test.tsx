// 侧边栏标题行：品牌块 + 主题 / 设置两个图标入口。「多节点互联」入口已并入设置页与「接入更多设备」面板。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 sidebar-device-list 测试同一套做法）。

import { describe, expect, test } from 'bun:test';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

// SidebarProvider 在构造 state 时就读 matchMedia；`matches` 即「桌面端」。
let desktopViewport = true;
(globalThis.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: desktopViewport,
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
const { LatencyBadge, SidebarTitle, latencyTooltipLines } = await import('./sidebar-title');

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

function renderMobile(mode: AuthModeResponse): string {
  desktopViewport = false;
  try {
    return render(mode);
  } finally {
    desktopViewport = true;
  }
}

function tagOf(html: string, testId: string): string {
  return html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';
}

describe('SidebarTitle', () => {
  test('渲染品牌块（logo + 站点名），链接回首页', () => {
    const html = render(MESH_MODE);
    expect(html).toContain('data-testid="brand"');
    expect(html).toContain(`src="${BRAND_LOGO_SRC}"`);
    expect(html).toContain(`>${PRODUCT_NAME}<`);
    expect(html).toContain('href="/"');
  });

  test('mesh 模式也不再渲染顶栏节点入口，设置入口仍在', () => {
    const html = render(MESH_MODE);
    expect(html).not.toContain('data-testid="sidebar-nodes"');
    expect(html).not.toContain('panel=nodes');
    expect(html).toContain('data-testid="sidebar-settings"');
    expect(html).toContain('href="/settings"');
  });

  test('standalone（mode:none）与未加载时同样只有设置入口', () => {
    for (const mode of [{ ...MESH_MODE, mode: 'none' as const }, null]) {
      const html = render(mode);
      expect(html).not.toContain('data-testid="sidebar-nodes"');
      expect(html).toContain('data-testid="sidebar-settings"');
    }
  });

  test('纯图标入口都带 aria-label 与说明气泡（主题、设置各一枚）', () => {
    const html = render(MESH_MODE);
    for (const label of ['settings.theme', 'sidebar.settings']) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html.split('data-slot="tooltip-trigger"').length - 1).toBe(2);
  });
});

describe('图标入口的焦点环', () => {
  // 抽屉打开时 Base UI 会把焦点移到里面第一个可聚焦元素（手机端就是「关闭侧边栏」）。
  // 焦点环只能给键盘操作，否则 PWA 冷启动后左上角一直挂着一圈描边。
  const focusRing = ['outline-none', 'focus-visible:ring-2', 'focus-visible:ring-ring'];

  test('设置入口只在 focus-visible 时出环', () => {
    const tag = tagOf(render(MESH_MODE), 'sidebar-settings');
    for (const cls of focusRing) expect(tag).toContain(cls);
  });

  test('手机端的关闭按钮同样只在 focus-visible 时出环', () => {
    const tag = tagOf(renderMobile(MESH_MODE), 'mobile-sidebar-close');
    expect(tag).not.toBe('');
    for (const cls of focusRing) expect(tag).toContain(cls);
  });
});

describe('WsLatency', () => {
  // store 的读数在服务端渲染下取的是初始快照（zustand 的 getServerSnapshot），
  // 所以顶栏那份永远是「没有读数」；有读数的形态直接渲染徽标组件。
  test('没有延迟读数时整块不渲染', () => {
    const html = render(MESH_MODE);
    expect(html).not.toContain('data-testid="ws-latency"');
  });

  test('有读数时给出可聚焦的徽标与说明气泡', () => {
    const html = renderToStaticMarkup(<LatencyBadge latency={240} rawLatency={null} />);
    expect(html).toContain('data-testid="ws-latency"');
    expect(html).toContain('240ms');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-slot="tooltip-trigger"');
  });

  test('气泡文案：原始样本与平滑读数一致时不重复第二行', () => {
    expect(latencyTooltipLines(240, null)).toEqual([{ key: 'nav.latencyTooltip' }]);
    expect(latencyTooltipLines(240, 240)).toEqual([{ key: 'nav.latencyTooltip' }]);
    expect(latencyTooltipLines(240, 310)).toEqual([
      { key: 'nav.latencyTooltip' },
      { key: 'nav.latencyTooltipRaw', ms: 310 },
    ]);
  });
});
