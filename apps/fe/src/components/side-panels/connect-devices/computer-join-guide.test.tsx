// 「让新机器加入」分支：按上级形态挑接入信息与 CLI 命令，加入码只留在折叠区里。
// 无 DOM 测试环境，用 react-dom/server 静态渲染。

import { afterEach, describe, expect, test } from 'bun:test';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
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
const { resetMeshRelayStateForTest, setMeshRelayStateForTest } = await import('@/node/mesh-relay');
const { resetEnrollmentEngineForTest } = await import('@/node/enrollment-engine');
const { JoinSteps, resolveJoinUplink } = await import('./computer-join-guide');
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

describe('resolveJoinUplink', () => {
  test('未加入 mesh：什么都给不出来', () => {
    expect(
      resolveJoinUplink({ mode: null, relayMode: false, relayUrl: null, tenantId: null })
    ).toEqual({ kind: 'unknown', url: null, tenantId: null });
  });

  test('hub 模式取 Hub 公开地址，不带租户编号', () => {
    expect(
      resolveJoinUplink({
        mode: MESH_MODE,
        relayMode: false,
        relayUrl: RELAY_URL,
        tenantId: TENANT,
      })
    ).toEqual({ kind: 'hub', url: HUB_URL, tenantId: null });
  });

  test('中继模式取中继地址与租户编号', () => {
    expect(
      resolveJoinUplink({ mode: MESH_MODE, relayMode: true, relayUrl: RELAY_URL, tenantId: TENANT })
    ).toEqual({ kind: 'relay', url: RELAY_URL, tenantId: TENANT });
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
  test('hub 模式：给 Hub 地址与 hub join 命令，加入码收在折叠区', () => {
    setMeshNodesStateForTest({ mode: MESH_MODE, modeLoaded: true, entryNodeId: ENTRY });
    const html = render(<JoinSteps />);
    expect(html).toContain('data-testid="command-block-join-uplink-url"');
    expect(html).toContain(HUB_URL);
    expect(html).toContain('connectDevices.computer.join.uplink.hubUrl');
    expect(html).toContain('connectDevices.computer.join.password.hubDescription');
    expect(html).toContain(`tmex hub join &#x27;${HUB_URL}&#x27; --password`);
    expect(html).not.toContain('data-testid="command-block-join-tenant-id"');
    expect(html).toContain('<details');
    expect(html).toContain('connectDevices.computer.join.advanced.title');
  });

  test('中继模式：给中继地址与可复制的租户编号，命令换成 relay join', () => {
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
    const html = render(<JoinSteps />);
    expect(html).toContain('connectDevices.computer.join.uplink.relayUrl');
    expect(html).toContain(RELAY_URL);
    expect(html).toContain('data-testid="command-block-join-tenant-id"');
    expect(html).toContain('data-testid="command-block-join-tenant-id-copy"');
    expect(html).toContain(TENANT);
    expect(html).toContain('connectDevices.computer.join.password.relayDescription');
    expect(html).toContain(`tmex relay join &#x27;${RELAY_URL}&#x27; --tenant ${TENANT}`);
  });

  test('中继模式下地址不可用：加入码那一步说的是中继，不是 Hub', () => {
    setMeshNodesStateForTest({
      mode: { ...MESH_MODE, hubPublicUrl: null },
      modeLoaded: true,
      entryNodeId: ENTRY,
    });
    setMeshRelayStateForTest({ mode: 'relay', tenantId: TENANT, relays: [], loadedAt: 1 });
    const html = render(<JoinSteps />);
    expect(html).toContain('data-testid="connect-join-no-url"');
    expect(html).toContain('nodes.enrollment.missingRelayUrl');
    expect(html).not.toContain('nodes.enrollment.missingHubUrl');
  });

  test('未加入 mesh：接入信息这步只给说明与设置入口', () => {
    const html = render(<JoinSteps />);
    expect(html).toContain('connectDevices.computer.join.uplink.unknownDescription');
    expect(html).toContain('data-testid="connect-join-uplink-link"');
    expect(html).not.toContain('data-testid="command-block-join-uplink-url"');
  });
});
