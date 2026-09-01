// NodeRuntimeBoundary 的路由 → 运行时映射。无 DOM 测试环境，用 react-dom/server 静态渲染
// （运行时在渲染期就已解析，effect 只负责引用计数）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AuthModeResponse, MeshNode } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter, Outlet, Route, Routes } = await import('react-router');
const { useRuntime } = await import('@tmex/stores/react');
const { NodeRouteGate, NodeRuntimeBoundary } = await import('./node-runtime-boundary');
const { appNodeRuntimes, nodeQueryClient } = await import('./node-runtimes');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('./mesh-nodes');

function RuntimeProbe() {
  const runtime = useRuntime();
  return (
    <span
      data-node-id={runtime.nodeId}
      data-base-url={runtime.apiClient.baseUrl}
      data-storage-prefix={runtime.storagePrefix}
      data-app-path={runtime.host.appPath?.('/devices/d1') ?? '/devices/d1'}
    />
  );
}

/**
 * 既有用例只关心「路由 → 运行时」的映射，不关心懒登录门闸；把 mesh store 置成
 * 「mode 已拉到且不是 mesh」，门闸就恒为 ready（等价于今天的单 node 形态）。
 */
function withoutMesh(): void {
  setMeshNodesStateForTest({ mode: null, modeLoaded: true, entryNodeId: null, nodes: [] });
}

/**
 * 生产里的形状：外壳（这里用 Shell 代替）挂在 `/` 这一层，`/n/:nodeId` 是它的**子级**路由，
 * 所以 `useRouteNodeId()` 必须从 pathname 解析——父级路由的 `useParams()` 读不到子级的
 * `:nodeId`。门闸只包页面区，运行时边界在它外面。
 */
function Shell() {
  return (
    <NodeRuntimeBoundary>
      <NodeRouteGate>
        <RuntimeProbe />
        <Outlet />
      </NodeRouteGate>
    </NodeRuntimeBoundary>
  );
}

function renderAt(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Shell />}>
          <Route path="n/:nodeId/*" element={<span data-testid="page" />} />
          <Route path="*" element={<span data-testid="page" />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('NodeRuntimeBoundary', () => {
  beforeEach(() => {
    withoutMesh();
  });

  afterEach(() => {
    resetMeshNodesStateForTest();
  });

  test('/n/:nodeId 路由渲染对应 node 的运行时', () => {
    const markup = renderAt('/n/0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a/devices/d1');
    expect(markup).toContain('data-node-id="0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"');
    expect(markup).toContain('data-base-url="/n/0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"');
    expect(markup).toContain('data-storage-prefix="n:0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a:"');
    expect(markup).toContain('data-app-path="/n/0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a/devices/d1"');
  });

  test('不同 nodeId 渲染不同运行时', () => {
    const a = renderAt('/n/0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a/devices/d1');
    const b = renderAt('/n/0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b/devices/d1');
    expect(a).toContain('data-base-url="/n/0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"');
    expect(b).toContain('data-base-url="/n/0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"');
    expect(appNodeRuntimes.get('0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a').runtime).not.toBe(
      appNodeRuntimes.get('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b').runtime
    );
  });

  test('旧路由（无 /n 前缀）等价于 self：URL 与 storage key 与单 node 时一致', () => {
    const markup = renderAt('/devices/d1');
    expect(markup).toContain('data-node-id="self"');
    expect(markup).toContain('data-base-url=""');
    expect(markup).toContain('data-storage-prefix=""');
    expect(markup).toContain('data-app-path="/devices/d1"');
  });

  test('外壳挂在父级路由上：nodeId 由 pathname 解析，父级 useParams 读不到子级的 :nodeId', () => {
    const markup = renderAt('/n/0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a/settings');
    expect(markup).toContain('data-node-id="0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"');
    // 页面区（子级路由）确实渲染在边界内部
    expect(markup).toContain('data-testid="page"');
  });

  test('/n/self/... 与旧路由是同一个运行时', () => {
    expect(appNodeRuntimes.get('self').runtime).toBe(appNodeRuntimes.get('').runtime);
    renderAt('/n/self/settings');
    expect(appNodeRuntimes.get('self').apiClient.baseUrl).toBe('');
  });
});

const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const REMOTE = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

const MESH_MODE: AuthModeResponse = {
  mode: 'mesh',
  nodeId: ENTRY,
  uid: 'user-1',
  username: 'alice',
  kdfParams: { salt: 'AAAAAAAAAAAAAAAAAAAAAA', memory_kib: 65536, iterations: 3, parallelism: 1 },
  passkeyAvailable: false,
  passkeysForThisOrigin: false,
};

function meshNode(overrides: Partial<MeshNode> & { id: string }): MeshNode {
  return {
    name: overrides.id,
    publicKey: 'AAAA',
    online: true,
    reach: 'lan',
    version: null,
    direct_capable: false,
    inventory: null,
    loggedIn: false,
    ...overrides,
  };
}

describe('未登录 node 的懒登录门闸', () => {
  afterEach(() => {
    resetMeshNodesStateForTest();
  });

  test('mesh 下进入在线但未登录的 node：先转圈，子树一个请求都不发', () => {
    setMeshNodesStateForTest({
      mode: MESH_MODE,
      modeLoaded: true,
      entryNodeId: ENTRY,
      loadedAt: Date.now(),
      nodes: [meshNode({ id: REMOTE })],
    });
    const markup = renderAt(`/n/${REMOTE}/devices/d1`);
    expect(markup).toContain(`data-testid="node-gate-pending-${REMOTE}"`);
    expect(markup).not.toContain('data-node-id=');
  });

  test('该 node 已登录时直接渲染子树', () => {
    setMeshNodesStateForTest({
      mode: MESH_MODE,
      modeLoaded: true,
      entryNodeId: ENTRY,
      loadedAt: Date.now(),
      nodes: [meshNode({ id: REMOTE, loggedIn: true })],
    });
    const markup = renderAt(`/n/${REMOTE}/devices/d1`);
    expect(markup).toContain(`data-node-id="${REMOTE}"`);
    expect(markup).not.toContain('data-testid="node-gate-pending-');
  });

  test('本机路由（旧路由 = self）永远不被门闸挡住', () => {
    setMeshNodesStateForTest({
      mode: MESH_MODE,
      modeLoaded: true,
      entryNodeId: ENTRY,
      loadedAt: Date.now(),
      nodes: [meshNode({ id: ENTRY, loggedIn: false })],
    });
    expect(renderAt('/devices/d1')).toContain('data-node-id="self"');
  });
});

/**
 * `GlobalDeviceProvider` 自带一条 `/api/devices` 查询，必须留在门闸**内部**：
 * 门闸没放行就挂上它，进未登录的远端 node 必定先吃一发 401 再重试。
 * 静态渲染下 `useQuery` 会把查询登记进该 node 的 QueryClient，据此断言它有没有被挂上。
 */
describe('设备列表查询受懒登录门闸约束', () => {
  const PENDING_NODE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
  const READY_NODE = '11111111111111111111111111111111';

  afterEach(() => {
    resetMeshNodesStateForTest();
  });

  function devicesQueryOf(nodeId: string): unknown {
    return nodeQueryClient(nodeId)
      .getQueryCache()
      .find({ queryKey: ['devices'] });
  }

  test('门闸未放行时不挂设备列表查询', () => {
    setMeshNodesStateForTest({
      mode: MESH_MODE,
      modeLoaded: true,
      entryNodeId: ENTRY,
      loadedAt: Date.now(),
      nodes: [meshNode({ id: PENDING_NODE })],
    });
    renderAt(`/n/${PENDING_NODE}/devices/d1`);
    expect(devicesQueryOf(PENDING_NODE)).toBeUndefined();
  });

  test('门闸放行后照常挂上', () => {
    setMeshNodesStateForTest({
      mode: MESH_MODE,
      modeLoaded: true,
      entryNodeId: ENTRY,
      loadedAt: Date.now(),
      nodes: [meshNode({ id: READY_NODE, loggedIn: true })],
    });
    renderAt(`/n/${READY_NODE}/devices/d1`);
    expect(devicesQueryOf(READY_NODE)).toBeDefined();
  });
});

interface DevicesData {
  devices: { id: string }[];
}

describe('每 node 的 QueryClient 缓存隔离', () => {
  test('不同 node 的 QueryClient 是不同实例，缓存互不可见', () => {
    const selfClient = nodeQueryClient('self');
    const aClient = nodeQueryClient('0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a');
    expect(selfClient).not.toBe(aClient);
    expect(nodeQueryClient('0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a')).toBe(aClient);

    const devicesKey = ['devices'] as const;
    selfClient.setQueryData<DevicesData>(devicesKey, { devices: [{ id: 'self-device' }] });
    aClient.setQueryData<DevicesData>(devicesKey, { devices: [{ id: 'a-device' }] });

    expect(selfClient.getQueryData<DevicesData>(devicesKey)).toEqual({
      devices: [{ id: 'self-device' }],
    });
    expect(aClient.getQueryData<DevicesData>(devicesKey)).toEqual({
      devices: [{ id: 'a-device' }],
    });

    // 一个 node 清空缓存不影响另一个 node
    aClient.clear();
    expect(aClient.getQueryData<DevicesData>(devicesKey)).toBeUndefined();
    expect(selfClient.getQueryData<DevicesData>(devicesKey)).toEqual({
      devices: [{ id: 'self-device' }],
    });
  });
});
