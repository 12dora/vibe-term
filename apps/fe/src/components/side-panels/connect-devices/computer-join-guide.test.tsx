// 「加入已有中继 / 加入已有 Hub」两条子路径：接入信息与 CLI 命令按所选路径摆，
// 加入码只在本机签得出来的时候才出现。无 DOM 测试环境，用 react-dom/server 静态渲染。

import { afterEach, describe, expect, test } from 'bun:test';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';
import type { ConnectMachine } from './use-connect-machine';

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
const { resetMeshRelayStateForTest, setMeshRelayStateForTest } = await import('@/node/mesh-relay');
const { resetEnrollmentEngineForTest } = await import('@/node/enrollment-engine');
const { JoinSteps, canIssueJoinToken, resolveJoinUplink } = await import('./computer-join-guide');
const { passwordJoinCommand, relayJoinCommand } = await import('./join-command-preview');

const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const HUB_URL = 'https://hub.example.com';
const RELAY_URL = 'https://relay.example.com';
const TENANT = 'aabbccddeeff00112233445566778899';

const MESH_MODE: AuthModeResponse = {
  mode: 'mesh',
  nodeId: ENTRY,
  uid: 'user-1',
  username: 'alice',
  kdfParams: { salt: 'AAAAAAAAAAAAAAAAAAAAAA', memory_kib: 65536, iterations: 3, parallelism: 1 },
  passkeyAvailable: false,
  passkeysForThisOrigin: false,
  rootEpoch: 0,
  hubPublicUrl: HUB_URL,
};

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

const HUB_MACHINE = machine({ meshEnabled: true, mode: MESH_MODE, hubUrl: HUB_URL });
const RELAY_MACHINE = machine({
  meshEnabled: true,
  mode: MESH_MODE,
  relayMode: true,
  relayAttached: true,
  relayUrl: RELAY_URL,
  tenantId: TENANT,
});

afterEach(() => {
  resetMeshNodesStateForTest();
  resetMeshRelayStateForTest();
  resetEnrollmentEngineForTest();
});

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

/** 步骤圆点里的编号：静态标记里就是 marker span 的文本。 */
function stepIndex(html: string, testId: string): string | null {
  const match = new RegExp(`data-testid="${testId}-marker"[^>]*>([^<]*)<`).exec(html);
  return match ? match[1] : null;
}

describe('resolveJoinUplink', () => {
  test('中继路径取中继地址与租户编号', () => {
    expect(resolveJoinUplink('relay', RELAY_MACHINE)).toEqual({
      kind: 'relay',
      url: RELAY_URL,
      tenantId: TENANT,
      standalone: false,
    });
  });

  test('Hub 路径取 Hub 地址，不带租户编号', () => {
    expect(resolveJoinUplink('hub', HUB_MACHINE)).toEqual({
      kind: 'hub',
      url: HUB_URL,
      tenantId: null,
      standalone: false,
    });
  });

  test('什么都没接：地址给不出来，且标记为需先配置本机', () => {
    expect(resolveJoinUplink('relay', machine())).toEqual({
      kind: 'relay',
      url: null,
      tenantId: null,
      standalone: true,
    });
    expect(resolveJoinUplink('hub', machine()).standalone).toBe(true);
  });

  test('本机自己是中继：地址有了，就不再算「先配置本机」', () => {
    const relayHost = machine({ role: 'relay', relayUrl: RELAY_URL, relayPublicUrl: RELAY_URL });
    expect(resolveJoinUplink('relay', relayHost)).toEqual({
      kind: 'relay',
      url: RELAY_URL,
      tenantId: null,
      standalone: false,
    });
  });
});

describe('canIssueJoinToken', () => {
  test('中继路径要求本机自己就挂在中继上', () => {
    expect(canIssueJoinToken('relay', RELAY_MACHINE)).toBe(true);
    expect(canIssueJoinToken('relay', machine({ role: 'relay' }))).toBe(false);
  });

  test('Hub 路径一律给出加入码区（未组网时里面自会说明）', () => {
    expect(canIssueJoinToken('hub', machine())).toBe(true);
  });
});

describe('密码加入的命令', () => {
  test('Hub：地址未知时退回示例地址，口令不进命令行', () => {
    expect(passwordJoinCommand(null)).toBe("tmex hub join 'https://tmex.example.com' --password");
    expect(passwordJoinCommand(HUB_URL)).toBe(`tmex hub join '${HUB_URL}' --password`);
  });

  test('中继：租户编号未知时用占位符', () => {
    expect(
      relayJoinCommand({ relayUrl: RELAY_URL, tenantId: TENANT, tenantPlaceholder: '<id>' })
    ).toBe(`tmex relay join '${RELAY_URL}' --tenant ${TENANT}`);
    expect(relayJoinCommand({ relayUrl: null, tenantId: null, tenantPlaceholder: '<id>' })).toBe(
      "tmex relay join 'https://relay.example.com' --tenant '<id>'"
    );
  });

  test('不可信地址一律不进命令（畸形值等于命令注入）', () => {
    expect(passwordJoinCommand('https://hub.example; touch /tmp/pwn')).toContain(
      'tmex.example.com'
    );
  });
});

describe('JoinSteps', () => {
  test('Hub 路径：给 Hub 地址与 hub join 命令，加入码收在折叠区', () => {
    setMeshNodesStateForTest({ mode: MESH_MODE, modeLoaded: true, entryNodeId: ENTRY });
    const html = render(<JoinSteps variant="hub" machine={HUB_MACHINE} />);
    expect(html).toContain('data-testid="command-block-join-uplink-url"');
    expect(html).toContain(HUB_URL);
    expect(html).toContain('connectDevices.computer.join.uplink.hubUrl');
    expect(html).toContain('connectDevices.computer.join.password.hubDescription');
    expect(html).toContain(`tmex hub join &#x27;${HUB_URL}&#x27; --password`);
    expect(html).not.toContain('data-testid="command-block-join-tenant-id"');
    expect(html).toContain('<details');
    expect(html).toContain('connectDevices.computer.join.advanced.title');
    // 地址已经拿到：接入信息这步打勾。
    expect(html).toContain('data-step-state="done"');
  });

  test('中继路径：给中继地址与可复制的租户编号，命令换成 relay join', () => {
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
    const html = render(<JoinSteps variant="relay" machine={RELAY_MACHINE} />);
    expect(html).toContain('connectDevices.computer.join.uplink.relayUrl');
    expect(html).toContain(RELAY_URL);
    expect(html).toContain('data-testid="command-block-join-tenant-id"');
    expect(html).toContain('data-testid="command-block-join-tenant-id-copy"');
    expect(html).toContain(TENANT);
    expect(html).toContain('connectDevices.computer.join.password.relayDescription');
    expect(html).toContain(`tmex relay join &#x27;${RELAY_URL}&#x27; --tenant ${TENANT}`);
    expect(html).toContain('data-testid="connect-join-token-advanced"');
  });

  test('本机是中继但没有租户编号：地址照给，租户编号只留说明', () => {
    const relayHost = machine({ role: 'relay', relayUrl: RELAY_URL, relayPublicUrl: RELAY_URL });
    const html = render(<JoinSteps variant="relay" machine={relayHost} />);
    expect(html).toContain('data-testid="command-block-join-uplink-url"');
    expect(html).not.toContain('data-testid="command-block-join-tenant-id"');
    expect(html).toContain('data-testid="connect-join-tenant-missing"');
    // 本机自己签不出中继加入码：折叠区整块不出现。
    expect(html).not.toContain('data-testid="connect-join-token-advanced"');
  });

  test('中继地址未知：给出向运营者索取的提示与本机设置入口', () => {
    const html = render(<JoinSteps variant="relay" machine={machine()} />);
    expect(html).toContain('data-testid="connect-join-uplink-missing"');
    expect(html).toContain('connectDevices.computer.join.uplink.relayMissing');
    expect(html).toContain('data-testid="connect-join-uplink-link"');
    expect(html).not.toContain('data-testid="command-block-join-uplink-url"');
    expect(html).not.toContain('data-step-state="done"');
  });

  test('Hub 地址未知：提示换成向 Hub 管理员索取', () => {
    const html = render(<JoinSteps variant="hub" machine={machine()} />);
    expect(html).toContain('connectDevices.computer.join.uplink.hubMissing');
    expect(html).not.toContain('connectDevices.computer.join.uplink.relayMissing');
  });

  test('已经接了别的上级：地址给不出时不再引到本机设置', () => {
    const html = render(<JoinSteps variant="hub" machine={machine({ meshEnabled: true })} />);
    expect(html).toContain('data-testid="connect-join-uplink-missing"');
    expect(html).not.toContain('data-testid="connect-join-uplink-link"');
  });

  test('步骤编号从传入的起点接着排', () => {
    const html = render(<JoinSteps variant="hub" machine={machine()} startIndex={5} />);
    expect(stepIndex(html, 'connect-step-join-uplink')).toBe('5');
    expect(stepIndex(html, 'connect-step-join-password')).toBe('6');
  });
});
