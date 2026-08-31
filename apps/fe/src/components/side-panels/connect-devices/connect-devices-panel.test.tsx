// 「接入更多设备」面板：默认页（移动设备 / iOS）与两条分支的静态渲染断言。
// 无 DOM 测试环境，用 react-dom/server 静态渲染，点不了标签；换页后的内容直接渲染对应子组件。

import { describe, expect, test } from 'bun:test';
import { INSTALL_COMMAND } from '@tmex/shared';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

// SidebarProvider（NavLink 依赖）在构造 state 时就读 matchMedia。
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
const ConnectDevicesPanel = (await import('./connect-devices-panel')).default;
const { MobilePlatformSteps } = await import('./mobile-guide');
const { ComputerGuide, HostSteps } = await import('./computer-guide');

const ORIGIN = 'http://localhost:9663';

function render(node: React.ReactNode): string {
  const runtime = appNodeRuntimes.get('self').runtime;
  // 地址列表走 react-query（静态渲染下查询不会发出，只会按 origin 兜底）。
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

describe('ConnectDevicesPanel', () => {
  test('默认落在「移动设备」页，给出 iOS 三步与本机当前地址', () => {
    const html = render(<ConnectDevicesPanel />);
    expect(html).toContain('data-testid="connect-devices-panel"');
    expect(html).toContain('data-testid="connect-tab-mobile"');
    expect(html).toContain('data-testid="connect-tab-computer"');
    expect(html).toContain('data-testid="connect-platform-ios"');
    expect(html).toContain('data-testid="connect-platform-android"');
    for (const step of ['open', 'add', 'launch']) {
      expect(html).toContain(`data-testid="connect-step-ios-${step}"`);
    }
    // 数据未到、origin 是回环：只剩「当前地址」兜底并给出回环提示。
    expect(html).toContain('data-testid="command-block-address-0"');
    expect(html).toContain(ORIGIN);
    expect(html).toContain('data-testid="connect-loopback-hint"');
    expect(html).toContain('connectDevices.mobile.ios.open.title');
  });

  test('一级 / 二级都是真的 tab 组件：tablist + tab + tabpanel，未选中的页不挂载', () => {
    const html = render(<ConnectDevicesPanel />);
    expect(html.split('role="tablist"').length - 1).toBe(2);
    expect(html.split('role="tab"').length - 1).toBe(4);
    // 两层各一个当前面板：移动设备页、iOS 平台页。
    expect(html.split('role="tabpanel"').length - 1).toBe(2);
    expect(html).toContain('aria-selected="true"');
    // 未选中的分支不进 DOM。
    expect(html).not.toContain('data-testid="connect-step-install"');
    expect(html).not.toContain('data-testid="connect-step-android-add"');
  });

  test('移动设备页给出远程访问入口，链接不带 panel 参数（跳转即关面板）', () => {
    const html = render(<ConnectDevicesPanel />);
    expect(html).toContain('href="/settings?tab=remoteAccess"');
    expect(html).not.toContain('panel=connect');
  });

  test('Android 页换成 Android 三步', () => {
    const html = render(<MobilePlatformSteps platform="android" />);
    expect(html).toContain('data-testid="connect-step-android-add"');
    expect(html).toContain('connectDevices.mobile.android.add.title');
    expect(html).not.toContain('connect-step-ios-add');
  });
});

describe('ComputerGuide', () => {
  test('安装步骤给出安装命令与 PATH 兜底命令，默认展开「加入已有中继」四步', () => {
    const html = render(<ComputerGuide />);
    expect(html).toContain('data-testid="connect-step-install"');
    expect(html).toContain('data-testid="command-block-install"');
    expect(html).toContain('data-testid="command-block-install-copy"');
    expect(html).toContain(INSTALL_COMMAND);
    expect(html).toContain('export PATH=');
    expect(html).toContain('data-testid="connect-mode-join"');
    expect(html).toContain('data-testid="connect-mode-host"');
    for (const step of ['hub', 'token', 'run', 'confirm']) {
      expect(html).toContain(`data-testid="connect-step-join-${step}"`);
    }
    expect(html).toContain('data-testid="command-block-join"');
    expect(html).toContain('connectDevices.computer.join.run.example');
    expect(html).toContain('href="/settings?tab=nodes"');
    // 「选择接入方式」的按钮在卡片里、分支面板在卡片外，但同属一个 Tabs 根。
    expect(html.split('role="tablist"').length - 1).toBe(1);
    expect(html.split('role="tabpanel"').length - 1).toBe(1);
    expect(html).not.toContain('data-testid="connect-step-host-entry"');
  });

  test('「本机作为中继」分支给出三步、公开地址不可改的警示与两个设置入口', () => {
    const html = render(<HostSteps />);
    for (const step of ['entry', 'hub', 'invite']) {
      expect(html).toContain(`data-testid="connect-step-host-${step}"`);
    }
    expect(html).toContain('data-testid="connect-host-hub-warning"');
    expect(html).toContain('connectDevices.computer.host.hub.warning');
    expect(html).toContain('href="/settings?tab=remoteAccess"');
    expect(html).toContain('href="/settings?tab=nodes"');
  });
});
