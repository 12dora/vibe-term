// 「用到才登录」门闸的状态判定。无 DOM 测试环境，用 react-dom/server 静态渲染探针
// （effect 不会执行，因此这里测的纯粹是**该不该挡**，静默登录本身由 ensureNodeLogin 的用例覆盖）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AuthModeResponse, MeshNode } from '@vibeterm/api-client/auth/index';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('@/node/mesh-nodes');
const { shouldAttemptSilentLogin, useNodeLoginGate } = await import('./use-node-login');
const {
  getNodeLoginFailure,
  noteNodeLoginFailure,
  noteNodeLoginSuccess,
  setNodeLoginRetryTimersForTest,
} = await import('./node-login-retry');

const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

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

function Probe({ nodeId, enabled }: { nodeId: string; enabled?: boolean }) {
  const gate = useNodeLoginGate(nodeId, enabled === undefined ? {} : { enabled });
  return <span data-status={gate.status} />;
}

function statusOf(nodeId: string, enabled?: boolean): string {
  const markup = renderToStaticMarkup(<Probe nodeId={nodeId} enabled={enabled} />);
  return /data-status="([^"]+)"/.exec(markup)?.[1] ?? '';
}

afterEach(() => {
  resetMeshNodesStateForTest();
});

describe('useNodeLoginGate', () => {
  test('mode 还没拉到：先等，不拿一个不确定的状态去渲染远端 node 的页面', () => {
    expect(statusOf(NODE_A)).toBe('pending');
  });

  test('standalone（mode:none）永不挡', () => {
    setMeshNodesStateForTest({ mode: { ...MESH_MODE, mode: 'none' }, modeLoaded: true });
    expect(statusOf(NODE_A)).toBe('ready');
  });

  test('mode 拉取失败（modeLoaded 但 mode 为空）也放行，不无限转圈', () => {
    setMeshNodesStateForTest({ mode: null, modeLoaded: true });
    expect(statusOf(NODE_A)).toBe('ready');
  });

  test('本机（self 与 entry 自身的 id）永不挡', () => {
    setMeshNodesStateForTest({
      mode: MESH_MODE,
      modeLoaded: true,
      entryNodeId: ENTRY,
      loadedAt: Date.now(),
      nodes: [meshNode({ id: ENTRY, loggedIn: false })],
    });
    expect(statusOf('self')).toBe('ready');
    expect(statusOf(ENTRY)).toBe('ready');
  });

  test('mesh 列表还没拉过：先等列表，不放行也不判失败', () => {
    setMeshNodesStateForTest({ mode: MESH_MODE, modeLoaded: true, entryNodeId: ENTRY });
    expect(statusOf(NODE_A)).toBe('pending');
  });

  test('首帧缓存已登录：不等 loadedAt / mode，当场放行', () => {
    setMeshNodesStateForTest({
      cachedMesh: true,
      entryNodeId: ENTRY,
      stale: true,
      nodes: [meshNode({ id: NODE_A, loggedIn: true })],
    });
    expect(statusOf(NODE_A)).toBe('ready');
  });

  test('首帧缓存未登录：不等列表 REST，直接走登录', () => {
    setMeshNodesStateForTest({
      cachedMesh: true,
      entryNodeId: ENTRY,
      stale: true,
      nodes: [meshNode({ id: NODE_A, loggedIn: false })],
    });
    expect(statusOf(NODE_A)).toBe('pending');
  });

  test('首帧缓存离线：不挡页面', () => {
    setMeshNodesStateForTest({
      cachedMesh: true,
      entryNodeId: ENTRY,
      stale: true,
      nodes: [meshNode({ id: NODE_A, online: false, loggedIn: false })],
    });
    expect(statusOf(NODE_A)).toBe('ready');
  });

  test('缓存和列表都没有这一行：仍等 REST', () => {
    setMeshNodesStateForTest({
      cachedMesh: true,
      entryNodeId: ENTRY,
      stale: true,
      nodes: [meshNode({ id: ENTRY, loggedIn: true })],
    });
    expect(statusOf(NODE_A)).toBe('pending');
  });

  test('mode 已落地的缓存已登录行：loadedAt 仍为空也放行', () => {
    setMeshNodesStateForTest({
      mode: MESH_MODE,
      modeLoaded: true,
      entryNodeId: ENTRY,
      cachedMesh: true,
      stale: true,
      nodes: [meshNode({ id: NODE_A, loggedIn: true })],
    });
    expect(statusOf(NODE_A)).toBe('ready');
  });

  test('列表拉取失败时放行，不做无限转圈', () => {
    setMeshNodesStateForTest({
      mode: MESH_MODE,
      modeLoaded: true,
      entryNodeId: ENTRY,
      error: 'boom',
    });
    expect(statusOf(NODE_A)).toBe('ready');
  });

  test('在线但未登录 → 挡住并去静默登录；已登录 / 离线 / 不在列表里 → 放行', () => {
    const base = { mode: MESH_MODE, modeLoaded: true, entryNodeId: ENTRY, loadedAt: Date.now() };
    setMeshNodesStateForTest({ ...base, nodes: [meshNode({ id: NODE_A })] });
    expect(statusOf(NODE_A)).toBe('pending');

    setMeshNodesStateForTest({ ...base, nodes: [meshNode({ id: NODE_A, loggedIn: true })] });
    expect(statusOf(NODE_A)).toBe('ready');

    setMeshNodesStateForTest({ ...base, nodes: [meshNode({ id: NODE_A, online: false })] });
    expect(statusOf(NODE_A)).toBe('ready');

    setMeshNodesStateForTest({ ...base, nodes: [] });
    expect(statusOf(NODE_A)).toBe('ready');
  });

  test('enabled=false（侧边栏折叠态）恒为 ready：不挡也不登录', () => {
    setMeshNodesStateForTest({
      mode: MESH_MODE,
      modeLoaded: true,
      entryNodeId: ENTRY,
      loadedAt: Date.now(),
      nodes: [meshNode({ id: NODE_A })],
    });
    expect(statusOf(NODE_A, false)).toBe('ready');
    expect(statusOf(NODE_A, true)).toBe('pending');
  });
});

describe('shouldAttemptSilentLogin', () => {
  interface Handle {
    fire: () => void;
  }
  let pending: Handle[] = [];

  beforeEach(() => {
    pending = [];
    setNodeLoginRetryTimersForTest({
      schedule: (fn) => {
        const handle: Handle = {
          fire: () => {
            pending = pending.filter((item) => item !== handle);
            fn();
          },
        };
        pending.push(handle);
        return handle;
      },
      cancel: (handle) => {
        pending = pending.filter((item) => item !== handle);
      },
      random: () => 0,
    });
  });

  afterEach(() => setNodeLoginRetryTimersForTest(null));

  const codeOf = (nodeId: string) => getNodeLoginFailure(nodeId)?.code ?? null;

  test('不需要登录时一个请求都不发', () => {
    expect(shouldAttemptSilentLogin(false, null)).toBe(false);
    expect(shouldAttemptSilentLogin(false, 'NODE_UNREACHABLE')).toBe(false);
  });

  test('网络类失败：记录在时按住不重发，退避到点抹掉记录后条件重新成立', () => {
    noteNodeLoginFailure(NODE_A, 'NODE_UNREACHABLE');
    expect(shouldAttemptSilentLogin(true, codeOf(NODE_A))).toBe(false);
    expect(pending).toHaveLength(1);
    pending[0].fire();
    expect(shouldAttemptSilentLogin(true, codeOf(NODE_A))).toBe(true);
  });

  test('凭证类失败一直按住：没有退避，等用户介入', () => {
    noteNodeLoginFailure(NODE_A, 'NO_SESSION_KEY');
    expect(pending).toHaveLength(0);
    expect(shouldAttemptSilentLogin(true, codeOf(NODE_A))).toBe(false);
    noteNodeLoginSuccess(NODE_A);
    expect(shouldAttemptSilentLogin(true, codeOf(NODE_A))).toBe(true);
  });
});
