// 加入会话的 sessionStorage 旧键迁移：升级后刷新页面，步骤 6 仍要停在改名前那条会话上。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（effect 不跑，读取发生在 useState 初值里）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AuthModeResponse } from '@vibeterm/api-client/auth/index';
import { createMemoryStorage, installWindowStorage } from '@vibeterm/stores/test-utils';
import type { JoinSession } from './join-token';
import type { ConnectMachine } from './use-connect-machine';

installWindowStorage();

// SidebarProvider（NavLink 依赖）在构造 state 时就读 matchMedia。
(globalThis.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

const store = createMemoryStorage();
Object.defineProperty(globalThis, 'sessionStorage', {
  value: store,
  configurable: true,
  writable: true,
});

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { RuntimeProvider } = await import('@vibeterm/stores/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { SidebarProvider } = await import('@vibeterm/ui/sidebar');
const { appNodeRuntimes } = await import('@/node/node-runtimes');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('@/node/mesh-nodes');
const { resetMeshRelayStateForTest } = await import('@/node/mesh-relay');
const { resetEnrollmentEngineForTest } = await import('@/node/enrollment-engine');
const { JoinSteps } = await import('./computer-join-guide');

const LEGACY_KEY = 'tmex.connectDevices.joinSession';
const CURRENT_KEY = 'vibeterm.connectDevices.joinSession';

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

const MACHINE: ConnectMachine = {
  role: null,
  relayAttached: false,
  relayMode: false,
  meshEnabled: true,
  mode: MESH_MODE,
  relayUrl: null,
  tenantId: null,
  hubUrl: HUB_URL,
  relayPublicUrl: null,
  relayHasPassword: false,
};

/** 已加入的会话：pending 早已被删，只剩这个标记能让步骤 6 继续说「已加入」。 */
function admittedSession(over: Partial<JoinSession> = {}): JoinSession {
  return {
    id: 'e-legacy',
    enrollPk: 'pk-legacy',
    createdAt: 1_700_000_000_000,
    exp: 1_700_000_600_000,
    uid: MESH_MODE.uid ?? null,
    hubNodeId: HUB_NODE,
    admitted: true,
    admittedAt: Date.now(),
    nodeId: null,
    ...over,
  };
}

function render(): string {
  const runtime = appNodeRuntimes.get('self').runtime;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <MemoryRouter>
      <RuntimeProvider runtime={runtime}>
        <QueryClientProvider client={queryClient}>
          <SidebarProvider>
            <JoinSteps variant="hub" machine={MACHINE} />
          </SidebarProvider>
        </QueryClientProvider>
      </RuntimeProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  store.clear();
  setMeshNodesStateForTest({ mode: MESH_MODE, modeLoaded: true, entryNodeId: ENTRY });
});

afterEach(() => {
  resetMeshNodesStateForTest();
  resetMeshRelayStateForTest();
  resetEnrollmentEngineForTest();
});

describe('加入会话的旧存储键迁移', () => {
  test('只有旧键：会话被接上，值搬到新键且旧键删除', () => {
    const session = admittedSession();
    store.setItem(LEGACY_KEY, JSON.stringify(session));

    const html = render();

    expect(html).toContain('data-testid="connect-join-admitted"');
    expect(store.getItem(CURRENT_KEY)).toBe(JSON.stringify(session));
    expect(store.getItem(LEGACY_KEY)).toBeNull();
  });

  test('新旧两个键都有：新键的会话说了算，旧键只是被删掉', () => {
    // 旧键那条是「已加入」，新键那条既没加入也没有对应 pending，恢复出来会被判无效。
    const current = admittedSession({ id: 'e-current', admitted: false, admittedAt: null });
    store.setItem(LEGACY_KEY, JSON.stringify(admittedSession()));
    store.setItem(CURRENT_KEY, JSON.stringify(current));

    const html = render();

    expect(html).not.toContain('data-testid="connect-join-admitted"');
    expect(store.getItem(CURRENT_KEY)).toBe(JSON.stringify(current));
    expect(store.getItem(LEGACY_KEY)).toBeNull();
  });
});
