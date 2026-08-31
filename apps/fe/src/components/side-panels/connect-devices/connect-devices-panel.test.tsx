// 「接入更多设备」面板：默认页（移动设备 / iOS）与两条分支的静态渲染断言。
// 无 DOM 测试环境，用 react-dom/server 静态渲染，点不了标签；换页后的内容直接渲染对应子组件。

import { afterEach, describe, expect, test } from 'bun:test';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
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
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('@/node/mesh-nodes');
const ConnectDevicesPanel = (await import('./connect-devices-panel')).default;
const { MobilePlatformSteps } = await import('./mobile-guide');
const { ComputerGuide, HostSteps } = await import('./computer-guide');
const { JoinConfirmStatus, joinTokenTtlMinutes } = await import('./join-token');
const { getEnrollmentEngineState, resetEnrollmentEngineForTest, setEnrollmentEngineStateForTest } =
  await import('@/node/enrollment-engine');
const { joinCommandPreview } = await import('./join-command-preview');

const ORIGIN = 'http://localhost:9663';
const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const HUB_NODE = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';
const HUB_URL = 'https://hub.example.com';

const MESH_MODE: AuthModeResponse = {
  mode: 'mesh',
  nodeId: ENTRY,
  uid: 'user-1',
  username: 'alice',
  kdfParams: { salt: 'AAAAAAAAAAAAAAAAAAAAAA', memory_kib: 65536, iterations: 3, parallelism: 1 },
  passkeyAvailable: false,
  passkeysForThisOrigin: false,
  rootEpoch: 0,
  hubNodeId: HUB_NODE,
  hubPublicUrl: HUB_URL,
};

afterEach(() => {
  resetMeshNodesStateForTest();
  resetEnrollmentEngineForTest();
});

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

describe('JoinSteps 的加入码', () => {
  // i18n 未初始化，`t()` 原样返回 key：占位符断言直接用 key 字符串。
  const TOKEN_KEY = 'connectDevices.computer.join.run.tokenPlaceholder';
  const NAME_KEY = 'connectDevices.computer.join.run.namePlaceholder';

  test('未加入 mesh：说明无法在此生成，命令块给示例地址的预览', () => {
    const html = render(<ComputerGuide />);
    expect(html).toContain('data-testid="connect-join-token-unavailable"');
    expect(html).toContain('connectDevices.computer.join.token.unavailable');
    expect(html).toContain('connectDevices.computer.join.token.description');
    expect(html).not.toContain('data-testid="connect-join-generate"');
    expect(html).not.toContain('data-testid="connect-join-name"');
    expect(html).toContain('tmex.example.com');
    expect(html).toContain(`--token ${TOKEN_KEY} --name ${NAME_KEY}`);
    expect(html).toContain('connectDevices.computer.join.run.description');
    expect(html).not.toContain('connectDevices.computer.join.run.ready');
    // 还没有加入码：不该出现「等待新节点加入」。
    expect(html).not.toContain('data-testid="connect-join-pending"');
  });

  test('mesh 模式：给出节点名输入与生成按钮，预览命令用 hub 的公开地址', () => {
    setMeshNodesStateForTest({ mode: MESH_MODE, modeLoaded: true, entryNodeId: ENTRY });
    const html = render(<ComputerGuide />);
    expect(html).toContain('data-testid="connect-join-name"');
    expect(html).toContain('data-testid="connect-join-generate"');
    expect(html).toContain('nodes.enrollment.create');
    expect(html).toContain('connectDevices.computer.join.token.meshDescription');
    expect(html).not.toContain('data-testid="connect-join-token-unavailable"');
    expect(html).toContain('hub.example.com');
    expect(html).toContain(`--token ${TOKEN_KEY} --name ${NAME_KEY}`);
    expect(html).not.toContain('tmex.example.com');
    // hub 管理面还没探测成功（静态渲染不跑 effect）：按钮禁用而不是消失。
    expect(html).toContain('disabled=""');
  });

  test('mesh 模式但 hub 没有可信公开地址：只给设置入口，不给生成按钮', () => {
    setMeshNodesStateForTest({
      mode: { ...MESH_MODE, hubPublicUrl: 'ftp://hub.example.com' },
      modeLoaded: true,
      entryNodeId: ENTRY,
    });
    const html = render(<ComputerGuide />);
    expect(html).toContain('data-testid="connect-join-no-url"');
    expect(html).toContain('nodes.enrollment.missingHubUrl');
    expect(html).not.toContain('data-testid="connect-join-generate"');
    expect(html).toContain('href="/settings?tab=nodes"');
  });
});

describe('joinCommandPreview', () => {
  test('形状与真实命令一致：未知 hub 地址退回示例地址，节点名为空时用占位符', () => {
    expect(
      joinCommandPreview({
        hubPublicUrl: null,
        name: '',
        tokenPlaceholder: '<join-token>',
        namePlaceholder: '<node-name>',
      })
    ).toBe("tmex hub join 'https://tmex.example.com' --token <join-token> --name <node-name>");
  });

  test('可信 hub 地址与输入的节点名实时进命令，节点名按真实命令的规则引用', () => {
    expect(
      joinCommandPreview({
        hubPublicUrl: HUB_URL,
        name: '  my node  ',
        tokenPlaceholder: '<join-token>',
        namePlaceholder: '<node-name>',
      })
    ).toBe(`tmex hub join '${HUB_URL}' --token <join-token> --name 'my node'`);
  });

  test('不可信的 hub 地址一律不进命令（畸形值等于命令注入）', () => {
    expect(
      joinCommandPreview({
        hubPublicUrl: 'https://hub.example; touch /tmp/pwn',
        name: 'a',
        tokenPlaceholder: '<t>',
        namePlaceholder: '<n>',
      })
    ).toBe("tmex hub join 'https://tmex.example.com' --token <t> --name a");
  });
});

describe('JoinSteps 步骤 6「确认加入」', () => {
  const PENDING = {
    hubEnrollmentId: 'e-1',
    enrollPk: 'pk',
    authorizationBytes: 'a',
    authorizationSig: 's',
    exp: 1_700_000_600_000,
    name: 'studio',
    createdAt: 1_700_000_000_000,
  };

  function confirmStatus(patch: Parameters<typeof setEnrollmentEngineStateForTest>[0]): string {
    setEnrollmentEngineStateForTest(patch);
    const enrollment = {
      meshEnabled: true,
      hubOnline: true,
      pending: PENDING,
      engine: getEnrollmentEngineState(),
    } as unknown as Parameters<typeof JoinConfirmStatus>[0]['enrollment'];
    return render(<JoinConfirmStatus enrollment={enrollment} />);
  }

  test('等待中：只有「等待新节点加入」，没有确认按钮', () => {
    const html = confirmStatus({});
    expect(html).toContain('data-testid="connect-join-pending"');
    expect(html).toContain('nodes.enrollment.pending');
    expect(html).not.toContain('data-testid="connect-join-confirm"');
  });

  test('证书已到（passkey 用户签不了）：给出「确认加入」按钮', () => {
    const html = confirmStatus({ certificateReadyIds: ['e-1'] });
    expect(html).toContain('data-testid="connect-join-confirm"');
    expect(html).toContain('nodes.enrollment.confirmPending');
  });

  test('hub 未确认：文案与按钮都换成重试', () => {
    const html = confirmStatus({ hubUnconfirmedIds: ['e-1'] });
    expect(html).toContain('nodes.enrollment.hubNotConfirmed');
    expect(html).toContain('nodes.enrollment.retryHub');
  });

  test('已加入：只剩「已加入」提示', () => {
    const html = confirmStatus({ admittedIds: ['e-1'] });
    expect(html).toContain('data-testid="connect-join-admitted"');
    expect(html).toContain('connectDevices.computer.join.confirm.done');
    expect(html).not.toContain('data-testid="connect-join-confirm"');
  });

  test('证书判定失败：给出与设置页同一条错误文案', () => {
    const html = confirmStatus({ invalidById: { 'e-1': 'nodes.enrollment.badCertSig' } });
    expect(html).toContain('data-testid="connect-join-invalid"');
    expect(html).toContain('nodes.enrollment.badCertSig');
  });

  test('本次会话还没有 pending 时什么都不渲染', () => {
    const enrollment = {
      pending: null,
      engine: getEnrollmentEngineState(),
    } as unknown as Parameters<typeof JoinConfirmStatus>[0]['enrollment'];
    const html = render(<JoinConfirmStatus enrollment={enrollment} />);
    expect(html).not.toContain('data-testid="connect-join-pending"');
    expect(html).not.toContain('data-testid="connect-join-admitted"');
  });

  test('加入码有效期由 pending 自身反推，不写死', () => {
    expect(joinTokenTtlMinutes(PENDING)).toBe(10);
    expect(joinTokenTtlMinutes({ ...PENDING, exp: PENDING.createdAt + 90_000 })).toBe(2);
    expect(joinTokenTtlMinutes({ ...PENDING, exp: PENDING.createdAt })).toBe(1);
  });
});
