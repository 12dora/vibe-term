// 「接入更多设备」面板：默认页（移动设备 / iOS）与两条分支的静态渲染断言。
// 无 DOM 测试环境，用 react-dom/server 静态渲染，点不了标签；换页后的内容直接渲染对应子组件。

import { afterEach, describe, expect, test } from 'bun:test';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import { INSTALL_COMMAND } from '@tmex/shared';
import { installWindowStorage } from '@tmex/stores/test-utils';
import type { AccessAddress } from './access-addresses';

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
const { AddressChoiceList, MobilePlatformSteps, ScanBlock } = await import('./mobile-guide');
const { ComputerGuide } = await import('./computer-guide');
const { HostSteps } = await import('./hub-host-steps');
const { RelayHostSteps } = await import('./relay-host-steps');
const { SshSteps } = await import('./ssh-steps');
const { JoinSteps } = await import('./computer-join-guide');
const { resetMeshRelayStateForTest, setMeshRelayStateForTest } = await import('@/node/mesh-relay');
type ConnectMachine = Parameters<typeof RelayHostSteps>[0]['machine'];
const { ADMITTED_SESSION_TTL_MS, JoinConfirmStatus, isSessionValid, joinTokenTtlMinutes } =
  await import('./join-token');
type JoinSession = Parameters<typeof isSessionValid>[0];
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
  resetMeshRelayStateForTest();
  resetEnrollmentEngineForTest();
});

function machine(over: Partial<ConnectMachine> = {}): ConnectMachine {
  return {
    role: null,
    relayAttached: false,
    relayMode: false,
    meshEnabled: false,
    mode: null,
    relayUrl: null,
    tenantId: null,
    hubUrl: null,
    relayPublicUrl: null,
    relayHasPassword: false,
    ...over,
  };
}

/** 步骤圆点里的编号：静态标记里就是 marker span 的文本。 */
function stepIndex(html: string, testId: string): string | null {
  const match = new RegExp(`data-testid="${testId}-marker"[^>]*>([^<]*)<`).exec(html);
  return match ? match[1] : null;
}

const RELAY_URL = 'https://relay.example.com';
const TENANT = 'aabbccddeeff00112233445566778899';

function attachRelay(): void {
  setMeshNodesStateForTest({ mode: MESH_MODE, modeLoaded: true, entryNodeId: ENTRY });
  setMeshRelayStateForTest({
    mode: 'relay',
    tenantId: TENANT,
    relays: [
      {
        url: RELAY_URL,
        priority: 1,
        online: true,
        attached: true,
        rttMs: null,
        lastError: null,
        kicked: false,
      },
    ],
    loadedAt: 1,
  });
}

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
  test('默认落在「移动设备」页，给出 iOS 四步与本机当前地址的二维码', () => {
    const html = render(<ConnectDevicesPanel />);
    expect(html).toContain('data-testid="connect-devices-panel"');
    expect(html).toContain('data-testid="connect-tab-mobile"');
    expect(html).toContain('data-testid="connect-tab-computer"');
    expect(html).toContain('data-testid="connect-platform-ios"');
    expect(html).toContain('data-testid="connect-platform-android"');
    for (const step of ['address', 'scan', 'add', 'launch']) {
      expect(html).toContain(`data-testid="connect-step-ios-${step}"`);
    }
    // 数据未到、origin 是回环：只剩「当前地址」兜底并给出回环提示。
    expect(html).toContain('data-testid="connect-access-addresses"');
    expect(html).toContain('data-testid="command-block-mobile-address"');
    expect(html).toContain('data-testid="connect-qr"');
    expect(html).toContain(ORIGIN);
    expect(html).toContain('data-testid="connect-loopback-hint"');
    expect(html).toContain('connectDevices.mobile.chooseAddress.title');
    expect(html).toContain('connectDevices.mobile.scan.ios');
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
    // 只有一个候选地址：这步退化成静态说明，不做成单选。
    expect(html).not.toContain('type="radio"');
  });

  test('移动设备页给出远程访问入口，链接不带 panel 参数（跳转即关面板）', () => {
    const html = render(<ConnectDevicesPanel />);
    expect(html).toContain('href="/settings?tab=remoteAccess"');
    expect(html).not.toContain('panel=connect');
  });

  test('Android 页换成 Android 的添加步骤与扫码提示', () => {
    const html = render(<MobilePlatformSteps platform="android" choice={choice(ADDRESSES)} />);
    expect(html).toContain('data-testid="connect-step-android-add"');
    expect(html).toContain('connectDevices.mobile.android.add.title');
    expect(html).toContain('connectDevices.mobile.scan.android');
    expect(html).not.toContain('connect-step-ios-add');
  });
});

const ADDRESSES: AccessAddress[] = [
  { kind: 'tunnel', url: 'https://tmex.example.com' },
  { kind: 'lan', url: 'http://192.168.1.20:9883' },
];

function choice(list: AccessAddress[], selectedIndex = 0) {
  return {
    list,
    loopbackHint: false,
    selected: list[selectedIndex] ?? null,
    onSelect: () => undefined,
  };
}

describe('移动设备页的地址选择与二维码', () => {
  test('多个候选做成一组原生单选：默认选中第一条，标签按种类给出', () => {
    const html = render(<AddressChoiceList {...choice(ADDRESSES)} />);
    expect(html).toContain('role="radiogroup"');
    expect(html.split('type="radio"').length - 1).toBe(2);
    expect(html).toContain('connectDevices.mobile.address.tunnel');
    expect(html).toContain('connectDevices.mobile.address.lan');
    // 第一条选中、第二条未选。
    expect(html.split('checked=""').length - 1).toBe(1);
    expect(html.indexOf('checked=""')).toBeLessThan(
      html.indexOf('data-testid="connect-address-1"')
    );
  });

  test('换一条地址：选中态跟着走', () => {
    const html = render(<AddressChoiceList {...choice(ADDRESSES, 1)} />);
    expect(html.split('checked=""').length - 1).toBe(1);
    expect(html.indexOf('data-testid="connect-address-1"')).toBeLessThan(
      html.indexOf('checked=""')
    );
  });

  test('只有一个候选时退化成静态说明，地址仍然摆出来', () => {
    const html = render(<AddressChoiceList {...choice([ADDRESSES[1]])} />);
    expect(html).not.toContain('type="radio"');
    expect(html).toContain('connectDevices.mobile.chooseAddress.single');
    expect(html).toContain('http://192.168.1.20:9883');
  });

  test('二维码内容随选中的地址变化，命令块同步给出可手输的地址', () => {
    const first = render(<ScanBlock platform="ios" url={ADDRESSES[0].url} />);
    const second = render(<ScanBlock platform="ios" url={ADDRESSES[1].url} />);
    expect(first).toContain('data-testid="connect-qr"');
    expect(first).toContain(ADDRESSES[0].url);
    expect(second).toContain(ADDRESSES[1].url);
    // 二维码本身也变了（同一份 SVG 路径说明没跟着选中项走）。
    const path = (html: string) => html.slice(html.indexOf('<svg'), html.indexOf('</svg>'));
    expect(path(first)).not.toBe(path(second));
  });

  test('没有任何候选地址时不渲染二维码', () => {
    const html = render(<ScanBlock platform="ios" url={null} />);
    expect(html).not.toContain('data-testid="connect-qr"');
    expect(html).not.toContain('data-testid="command-block-mobile-address"');
  });
});

describe('ComputerGuide 的路径选择', () => {
  test('三条路径都在第一步给出，附一行说明', () => {
    const html = render(<ComputerGuide />);
    expect(html).toContain('data-testid="connect-step-path"');
    for (const path of ['relay', 'hub', 'ssh']) {
      expect(html).toContain(`data-testid="connect-path-${path}"`);
      expect(html).toContain(`data-testid="connect-path-hint-${path}"`);
      expect(html).toContain(`connectDevices.computer.path.hint.${path}`);
    }
  });

  test('未组网：默认落在「经中继 → 本机自建中继」，不出现安装步骤', () => {
    const html = render(<ComputerGuide />);
    expect(html).toContain('data-testid="connect-side-relay-join"');
    expect(html).toContain('data-testid="connect-side-relay-host"');
    for (const step of ['setup', 'password', 'enroll', 'invite']) {
      expect(html).toContain(`data-testid="connect-step-relay-${step}"`);
    }
    expect(html).not.toContain('data-testid="connect-step-install"');
    expect(html).not.toContain('data-testid="connect-step-join-uplink"');
    // 未选中的路径不进 DOM。
    expect(html).not.toContain('data-testid="connect-step-host-entry"');
    expect(html).not.toContain('data-testid="connect-step-ssh-add"');
  });

  test('本机已接入 Hub：默认落在「经 Hub → 加入已有 Hub」，安装是第 2 步', () => {
    setMeshNodesStateForTest({ mode: MESH_MODE, modeLoaded: true, entryNodeId: ENTRY });
    const html = render(<ComputerGuide />);
    expect(html).toContain('data-testid="connect-side-hub-join"');
    expect(html).toContain('data-testid="connect-step-install"');
    expect(html).toContain('data-testid="command-block-install"');
    expect(html).toContain(INSTALL_COMMAND);
    expect(html).toContain('export PATH=');
    expect(stepIndex(html, 'connect-step-install')).toBe('2');
    expect(stepIndex(html, 'connect-step-join-password')).toBe('4');
    expect(html).toContain('connectDevices.computer.join.uplink.hubUrl');
    expect(html).toContain(HUB_URL);
    expect(html).toContain('data-testid="connect-join-token-advanced"');
  });

  test('本机走中继：默认落在「经中继 → 加入已有中继」，给中继地址与租户编号', () => {
    attachRelay();
    const html = render(<ComputerGuide />);
    expect(html).toContain('data-testid="connect-step-install"');
    expect(html).toContain('connectDevices.computer.join.uplink.relayUrl');
    expect(html).toContain(RELAY_URL);
    expect(html).toContain('data-testid="command-block-join-tenant-id"');
    expect(html).toContain(`tmex relay join &#x27;${RELAY_URL}&#x27; --tenant ${TENANT}`);
  });

  test('一级 tab 之下再套一层二级 tab，两层各只挂当前面板', () => {
    const html = render(<ComputerGuide />);
    expect(html.split('role="tablist"').length - 1).toBe(2);
    expect(html.split('role="tab"').length - 1).toBe(5);
    expect(html.split('role="tabpanel"').length - 1).toBe(2);
  });
});

describe('本机自建中继的三步', () => {
  test('本机还不是中继：四步待办，给出多节点互联入口', () => {
    const html = render(<RelayHostSteps machine={machine()} onSwitchToJoin={() => undefined} />);
    expect(html).toContain('connectDevices.computer.relayHost.setup.description');
    expect(html).toContain('data-testid="connect-relay-setup-requirement"');
    expect(html).toContain('data-testid="connect-relay-setup-link"');
    expect(html).toContain('href="/settings?tab=nodes"');
    // 还不是中继：不给中继管理的死链。
    expect(html).not.toContain('data-testid="connect-relay-password-link"');
    expect(html).not.toContain('data-step-state="done"');
    expect(html.split('data-step-state="todo"').length - 1).toBe(4);
    expect(stepIndex(html, 'connect-step-relay-setup')).toBe('2');
    expect(stepIndex(html, 'connect-step-relay-enroll')).toBe('4');
    expect(stepIndex(html, 'connect-step-relay-invite')).toBe('5');
  });

  test('本机已是中继但没设接入密码：第一步打勾，第二步给中继管理入口', () => {
    const html = render(
      <RelayHostSteps
        machine={machine({ role: 'relay,node', relayPublicUrl: RELAY_URL })}
        onSwitchToJoin={() => undefined}
      />
    );
    expect(html.split('data-step-state="done"').length - 1).toBe(1);
    expect(html).toContain('data-testid="command-block-relay-public-url"');
    expect(html).toContain(RELAY_URL);
    expect(html).toContain('data-testid="connect-relay-password-link"');
    expect(html).toContain('href="/settings?tab=relay"');
  });

  test('中继与接入密码都就绪、本机还没接进去：给出「接入本机中继」这一步，先不放去加入', () => {
    const html = render(
      <RelayHostSteps
        machine={machine({ role: 'relay', relayPublicUrl: RELAY_URL, relayHasPassword: true })}
        onSwitchToJoin={() => undefined}
      />
    );
    expect(html.split('data-step-state="done"').length - 1).toBe(2);
    expect(html).toContain('data-testid="connect-relay-password-done"');
    expect(html).toContain('connectDevices.computer.relayHost.enroll.description');
    expect(html).toContain('data-testid="connect-relay-enroll-link"');
    expect(html).toContain(`tmex relay enroll &#x27;${RELAY_URL}&#x27;`);
    // 没有租户编号，加入步骤给不出可执行的命令。
    expect(html).toContain('connectDevices.computer.relayHost.invite.blocked');
    expect(html).not.toContain('data-testid="connect-relay-goto-join"');
  });

  test('本机已接入自己的中继：三步打勾，租户编号可复制，可直接去加入', () => {
    const html = render(
      <RelayHostSteps
        machine={machine({
          role: 'relay,node',
          relayPublicUrl: RELAY_URL,
          relayHasPassword: true,
          relayMode: true,
          relayAttached: true,
          tenantId: TENANT,
        })}
        onSwitchToJoin={() => undefined}
      />
    );
    expect(html.split('data-step-state="done"').length - 1).toBe(3);
    expect(html).toContain('data-testid="command-block-relay-tenant-id"');
    expect(html).toContain(TENANT);
    expect(html).toContain('connectDevices.computer.relayHost.invite.description');
    expect(html).toContain('data-testid="connect-relay-goto-join"');
  });

  test('已是中继却没有对外地址：明确说别的机器加不进来', () => {
    const html = render(
      <RelayHostSteps machine={machine({ role: 'relay' })} onSwitchToJoin={() => undefined} />
    );
    expect(html).toContain('data-testid="connect-relay-missing-url"');
    expect(html).toContain('connectDevices.computer.relayHost.setup.missingUrl');
  });
});

describe('SSH 直连', () => {
  test('一句说明 + 一步添加设备，编号接在选择之后', () => {
    const html = render(<SshSteps />);
    expect(html).toContain('data-testid="connect-ssh-intro"');
    expect(html).toContain('connectDevices.computer.ssh.description');
    expect(html).toContain('data-testid="connect-step-ssh-add"');
    expect(html).toContain('data-testid="connect-ssh-add"');
    expect(html).toContain('data-testid="connect-ssh-note"');
    expect(stepIndex(html, 'connect-step-ssh-add')).toBe('2');
  });
});

describe('本机设为 Hub 的三步', () => {
  test('什么都没配时给出三步静态文案与两个设置入口', () => {
    const html = render(<HostSteps onSwitchToJoin={() => undefined} />);
    for (const step of ['entry', 'hub', 'invite']) {
      expect(html).toContain(`data-testid="connect-step-host-${step}"`);
    }
    expect(html).toContain('data-testid="connect-host-hub-warning"');
    expect(html).toContain('connectDevices.computer.host.hub.warning');
    expect(html).toContain('connectDevices.computer.host.entry.description');
    expect(html).toContain('connectDevices.computer.host.invite.description');
    expect(html).toContain('href="/settings?tab=remoteAccess"');
    expect(html).toContain('href="/settings?tab=nodes"');
    // 隧道状态与 auth mode 都没到：三步一律停在待办，不闪任何「已完成」。
    expect(html.split('data-step-state="todo"').length - 1).toBe(3);
    expect(html).not.toContain('data-step-state="done"');
    expect(html).not.toContain('data-testid="connect-host-goto-join"');
    expect(stepIndex(html, 'connect-step-host-entry')).toBe('2');
  });

  test('本机已是 Hub：入口与 Hub 两步打勾，给出公开地址并可直接去加入', () => {
    setMeshNodesStateForTest({
      mode: { ...MESH_MODE, hubNodeId: ENTRY },
      modeLoaded: true,
      entryNodeId: ENTRY,
    });
    const html = render(<HostSteps onSwitchToJoin={() => undefined} />);
    expect(html.split('data-step-state="done"').length - 1).toBe(2);
    // 没有隧道但已有 Hub 公开地址（直接连接）：入口这步按已配置算。
    expect(html).toContain('data-testid="connect-host-entry-status"');
    expect(html).toContain('connectDevices.computer.host.entry.status.hubUrl');
    expect(html).toContain('data-testid="connect-host-hub-status"');
    expect(html).toContain('connectDevices.computer.host.hub.status.self');
    expect(html).not.toContain('data-testid="connect-host-hub-warning"');
    expect(html).toContain('data-testid="connect-host-goto-join"');
    expect(html).toContain('connectDevices.computer.host.invite.ready');
  });

  test('本机只是节点：说明不能再当 Hub，且不给多节点互联入口', () => {
    setMeshNodesStateForTest({ mode: MESH_MODE, modeLoaded: true, entryNodeId: ENTRY });
    const html = render(<HostSteps onSwitchToJoin={() => undefined} />);
    expect(html).toContain('connectDevices.computer.host.hub.status.node');
    expect(html).not.toContain('data-testid="connect-host-hub-link"');
    expect(html).not.toContain('data-testid="connect-host-goto-join"');
    expect(html).toContain('connectDevices.computer.host.invite.description');
    // 上级 Hub 的地址不是本机的公网入口：本机没有隧道，入口这步仍是待办。
    expect(html).toContain('connectDevices.computer.host.entry.description');
    expect(html).not.toContain('data-testid="connect-host-entry-status"');
    expect(html).not.toContain('connectDevices.computer.host.entry.status.hubUrl');
    expect(html).not.toContain('data-step-state="done"');
  });
});

describe('加入码折叠区', () => {
  // i18n 未初始化，`t()` 原样返回 key：占位符断言直接用 key 字符串。
  const TOKEN_KEY = 'connectDevices.computer.join.run.tokenPlaceholder';
  const NAME_KEY = 'connectDevices.computer.join.run.namePlaceholder';

  test('未加入 mesh：说明无法在此生成，命令块给示例地址的预览', () => {
    const html = render(<JoinSteps variant="hub" machine={machine()} />);
    expect(html).toContain('data-testid="connect-join-token-unavailable"');
    expect(html).toContain('connectDevices.computer.join.token.unavailable');
    expect(html).toContain('connectDevices.computer.join.token.description');
    expect(html).not.toContain('data-testid="connect-join-generate"');
    expect(html).toContain('tmex.example.com');
    expect(html).toContain(`--token ${TOKEN_KEY} --name ${NAME_KEY}`);
    expect(html).toContain('connectDevices.computer.join.run.description');
    expect(html).not.toContain('data-testid="connect-join-pending"');
  });

  test('mesh 模式：给出节点名输入与生成按钮，预览命令用 hub 的公开地址', () => {
    setMeshNodesStateForTest({ mode: MESH_MODE, modeLoaded: true, entryNodeId: ENTRY });
    const html = render(
      <JoinSteps variant="hub" machine={machine({ meshEnabled: true, hubUrl: HUB_URL })} />
    );
    expect(html).toContain('data-testid="connect-join-name"');
    expect(html).toContain('data-testid="connect-join-generate"');
    expect(html).toContain('nodes.enrollment.create');
    expect(html).toContain('connectDevices.computer.join.token.meshDescription');
    expect(html).toContain('hub.example.com');
    expect(html).toContain(`--token ${TOKEN_KEY} --name ${NAME_KEY}`);
    // hub 管理面还没探测成功（静态渲染不跑 effect）：按钮禁用而不是消失。
    expect(html).toContain('disabled=""');
  });

  test('mesh 模式但 hub 没有可信公开地址：只给设置入口，不给生成按钮', () => {
    setMeshNodesStateForTest({
      mode: { ...MESH_MODE, hubPublicUrl: 'ftp://hub.example.com' },
      modeLoaded: true,
      entryNodeId: ENTRY,
    });
    const html = render(<JoinSteps variant="hub" machine={machine({ meshEnabled: true })} />);
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

  const SESSION: JoinSession = {
    id: 'e-1',
    enrollPk: 'pk',
    createdAt: PENDING.createdAt,
    exp: PENDING.exp,
    uid: 'user-1',
    hubNodeId: HUB_NODE,
    admitted: false,
    admittedAt: null,
    nodeId: null,
  };

  function confirmStatus(
    patch: Parameters<typeof setEnrollmentEngineStateForTest>[0],
    session: JoinSession = SESSION
  ): string {
    setEnrollmentEngineStateForTest(patch);
    const enrollment = {
      meshEnabled: true,
      hubOnline: true,
      session,
      engine: getEnrollmentEngineState(),
      confirmManually: () => undefined,
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

  test('刷新后引擎投影没了，会话里的「已加入」标记仍然显示', () => {
    const html = confirmStatus({}, { ...SESSION, admitted: true, admittedAt: PENDING.createdAt });
    expect(html).toContain('data-testid="connect-join-admitted"');
    expect(html).not.toContain('data-testid="connect-join-confirm"');
  });

  test('本次会话还没有 enrollment 时什么都不渲染', () => {
    const enrollment = {
      session: null,
      engine: getEnrollmentEngineState(),
      confirmManually: () => undefined,
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

describe('isSessionValid', () => {
  const NOW = 1_700_000_100_000;
  const SESSION: JoinSession = {
    id: 'e-1',
    enrollPk: 'pk',
    createdAt: 1_700_000_000_000,
    exp: 1_700_000_600_000,
    uid: 'user-1',
    hubNodeId: HUB_NODE,
    admitted: false,
    admittedAt: null,
    nodeId: null,
  };
  const PENDING = {
    hubEnrollmentId: 'e-1',
    enrollPk: 'pk',
    authorizationBytes: 'a',
    authorizationSig: 's',
    exp: 1_700_000_600_000,
    name: null,
    createdAt: 1_700_000_000_000,
  };
  const IDENTITY = { ready: true, uid: 'user-1', hubNodeId: HUB_NODE, nodeIds: null };

  function check(
    session: JoinSession,
    over: Partial<Parameters<typeof isSessionValid>[1]> = {}
  ): boolean {
    return isSessionValid(session, {
      identity: IDENTITY,
      pendings: [PENDING],
      admittedByEngine: false,
      now: NOW,
      ...over,
    });
  }

  test('未加入：id + enrollPk + createdAt 三样都要对上权威 pending', () => {
    expect(check(SESSION)).toBe(true);
    expect(check({ ...SESSION, enrollPk: 'other' })).toBe(false);
    expect(check({ ...SESSION, createdAt: 1 })).toBe(false);
    expect(check(SESSION, { pendings: [] })).toBe(false);
  });

  test('换了账号或换了 hub：这条会话一律作废', () => {
    expect(check({ ...SESSION, uid: 'user-2' })).toBe(false);
    expect(check({ ...SESSION, hubNodeId: 'other-hub' })).toBe(false);
    expect(check({ ...SESSION, uid: null })).toBe(false);
  });

  test('已加入的标记 24 小时后过期', () => {
    const admitted = { ...SESSION, admitted: true, admittedAt: NOW - 60_000 };
    expect(check(admitted, { pendings: [] })).toBe(true);
    expect(
      check({ ...admitted, admittedAt: NOW - ADMITTED_SESSION_TTL_MS - 1 }, { pendings: [] })
    ).toBe(false);
  });

  test('成员集拿得到时顺带对账：节点已经不在 mesh 里就不再说「已加入」', () => {
    const admitted = { ...SESSION, admitted: true, admittedAt: NOW, nodeId: 'node-a' };
    expect(
      check(admitted, {
        pendings: [],
        identity: { ...IDENTITY, nodeIds: ['node-a', 'node-b'] },
      })
    ).toBe(true);
    expect(check(admitted, { pendings: [], identity: { ...IDENTITY, nodeIds: ['node-b'] } })).toBe(
      false
    );
    // 列表还没加载出来（null）时不做判断，只按时效。
    expect(check(admitted, { pendings: [] })).toBe(true);
  });

  test('引擎刚刚 admit、pending 已被删：会话立刻按已加入处理', () => {
    expect(check(SESSION, { pendings: [], admittedByEngine: true })).toBe(true);
  });
});
