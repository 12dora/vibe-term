// 设置页「节点」标签的模式分派：standalone → HTTPS 区块 + 向导，mesh → 本机区块 + HTTPS 区块 + 节点管理。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 NodesPage 测试同一套做法）。

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import type { LocalStatusResponse } from '@tmex/api-client/local/types';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

// `useLocalStatus` 走 React Query，而 `FilePage.test.tsx` 用 `mock.module` 全局换掉了
// `@tanstack/react-query`（假 QueryClient）——直接渲染真 hook 会读到那份泄漏的 mock。
// 这里只测分派，所以把本目录的 hook 换成可控探针。
let localStatus: LocalStatusResponse | null = null;
let loginRequired = false;
mock.module('./use-local-status', () => ({
  LOCAL_STATUS_QUERY_KEY: ['local-status'],
  useLocalStatus: () => ({
    status: localStatus,
    loading: false,
    loginRequired,
    error: null,
    refresh: () => undefined,
  }),
}));

// HTTPS 区块同理：它自己的渲染分支在 `https/https-section.test.tsx` 里覆盖，这里只关心它挂上了。
mock.module('./https/use-tls-status', () => ({
  TLS_STATUS_QUERY_KEY: ['tls-status'],
  ACME_POLL_INTERVAL_MS: 3000,
  useTlsStatus: () => ({
    status: {
      mode: 'none',
      trustProxy: false,
      tlsPort: 9443,
      bindHost: '0.0.0.0',
      sans: [],
      caFingerprint: null,
      certificate: null,
      listener: { running: false, port: null, error: null },
      acme: null,
      restartRequired: false,
    },
    loading: false,
    loginRequired: false,
    error: null,
    refresh: () => undefined,
    setStatus: () => undefined,
  }),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('@/node/mesh-nodes');
const { setPendingStorage, clearPendingEnrollments, addPendingEnrollment } = await import(
  '@/node/enrollment'
);
const { NodesTab, routeSetupIntent } = await import('./nodes-tab');

const MESH_MODE: AuthModeResponse = {
  mode: 'mesh',
  nodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
  uid: 'user-1',
  username: 'alice',
  kdfParams: { salt: 'AAAAAAAAAAAAAAAAAAAAAA', memory_kib: 65536, iterations: 3, parallelism: 1 },
  passkeysForThisOrigin: false,
  passkeyAvailable: false,
  rootEpoch: 0,
};

function status(overrides: Partial<LocalStatusResponse> = {}): LocalStatusResponse {
  return {
    role: 'standalone',
    nodeEnv: 'production',
    hubUrl: null,
    hubPublicUrl: null,
    direct: {
      supported: true,
      installed: false,
      enabled: true,
      capable: false,
      version: null,
      platform: 'darwin-arm64',
    },
    tls: { mode: 'none', listenerRunning: false, tlsPort: null },
    domainAccess: { allowed: true, viaDomain: false, hosts: [] },
    relay: null,
    ...overrides,
  };
}

function render(mode: AuthModeResponse): string {
  resetMeshNodesStateForTest();
  setMeshNodesStateForTest({ mode, modeLoaded: true, entryNodeId: mode.nodeId });
  return renderToStaticMarkup(
    <MemoryRouter>
      <NodesTab />
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStatus = null;
  loginRequired = false;
  setPendingStorage({
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  clearPendingEnrollments();
});

describe('NodesTab standalone', () => {
  test('渲染本机区块与开启 hub 向导，不渲染节点表', () => {
    localStatus = status();
    const html = render({ ...MESH_MODE, mode: 'none' });
    expect(html).toContain('data-testid="local-machine-card"');
    expect(html).toContain('data-testid="hub-setup-wizard"');
    expect(html).toContain('data-testid="https-section"');
    // standalone 才提示「hub 公开地址必须是 https」
    expect(html).toContain('data-testid="https-hub-url-hint"');
    expect(html).not.toContain('data-testid="nodes-table"');
    // standalone 没有账号安全 / 节点页入口
    expect(html).not.toContain('data-testid="local-machine-account-security"');
  });

  test('直连插件不受支持时开关禁用', () => {
    localStatus = status({
      direct: {
        supported: false,
        installed: false,
        enabled: true,
        capable: false,
        version: null,
        platform: 'linux-riscv64',
      },
    });
    const html = render({ ...MESH_MODE, mode: 'none' });
    expect(html).toMatch(
      /data-testid="local-machine-direct-status"[^>]*data-direct-state="unsupported"/
    );
    expect(html).toMatch(/data-testid="local-machine-direct-switch"[^>]*disabled/);
  });
});

describe('NodesTab mesh', () => {
  test('渲染本机区块 + 节点管理，本机区块给出账号安全与节点页入口', () => {
    localStatus = status({ role: 'hub,node', hubPublicUrl: 'https://hub.example' });
    const html = render(MESH_MODE);
    expect(html).toContain('data-testid="local-machine-card"');
    expect(html).toContain('data-testid="local-machine-local-address"');
    expect(html).toContain('data-testid="nodes-table"');
    expect(html).toContain('data-testid="https-section"');
    expect(html).not.toContain('data-testid="https-hub-url-hint"');
    expect(html).not.toContain('data-testid="hub-setup-wizard"');
    expect(html).toContain('panel=security');
    expect(html).not.toContain('href="/account/security"');
    // `/nodes` 整页已移除，本机区块不再给它入口
    expect(html).not.toContain('href="/nodes"');
    expect(html).not.toContain('nodes.machine.openNodesPage');
    // compact：页级标题与管理主体自带的账号安全入口都不出现
    expect(html).not.toContain('data-testid="nodes-account-security"');
  });

  test('未登录时本机区块给登录提示而不是崩掉', () => {
    loginRequired = true;
    const html = render(MESH_MODE);
    expect(html).toContain('data-testid="local-machine-login-required"');
    expect(html).not.toContain('data-testid="local-machine-direct-switch"');
  });
});

describe('NodesTab HTTPS 分档', () => {
  test('hub 兼节点：HTTPS 正常可用', () => {
    localStatus = status({ role: 'hub,node', hubPublicUrl: 'https://hub.example' });
    const html = render(MESH_MODE);
    expect(html).toContain('data-testid="https-section"');
    expect(html).toContain('data-testid="https-mode-chooser"');
    expect(html).not.toContain('data-testid="https-node-role-hint"');
  });

  test('角色还没读到时不摆出 HTTPS 区块，只占一个小位子', () => {
    localStatus = null;
    const html = render(MESH_MODE);
    expect(html).toContain('data-testid="https-section-pending"');
    expect(html).not.toContain('data-testid="https-section"');
    // 关键是别在这段时间里露出可操作的 TLS 表单
    expect(html).not.toContain('data-testid="https-mode-chooser"');
  });

  test('未登录时连占位都不给（本机区块已经在提示登录）', () => {
    localStatus = null;
    loginRequired = true;
    const html = render(MESH_MODE);
    expect(html).not.toContain('data-testid="https-section-pending"');
    expect(html).not.toContain('data-testid="https-section"');
  });

  test('纯 node：卡片头还在，内容置灰并只留一句说明', () => {
    localStatus = status({ role: 'node', hubUrl: 'https://hub.example' });
    const html = render(MESH_MODE);
    expect(html).toContain('data-testid="https-section"');
    expect(html).toContain('nodes.https.title');
    expect(html).toContain('data-testid="https-node-role-hint"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('pointer-events-none opacity-60');
    // 置灰时不渲染任何可操作的 TLS 表单
    expect(html).not.toContain('data-testid="https-mode-chooser"');
    expect(html).not.toContain('data-testid="https-status-header"');
  });
});

describe('NodesTab 角色切换向导', () => {
  test('standalone 默认不预选路径，两条路径都摆着', () => {
    localStatus = status();
    const html = render({ ...MESH_MODE, mode: 'none' });
    expect(html).toContain('data-testid="hub-setup-wizard"');
    expect(html).toContain('data-selected="false"');
    expect(html).not.toContain('data-testid="setup-join-hub-form"');
    expect(html).not.toContain('data-testid="setup-become-hub-form"');
  });
});

describe('routeSetupIntent', () => {
  test('没有记号：什么都不预选', () => {
    expect(routeSetupIntent(null, false)).toEqual({
      wizardPath: null,
      relayRole: 'relay,node',
      requestedTab: null,
    });
  });

  test('hub 两条路径：预选向导并落在 Hub tab', () => {
    expect(routeSetupIntent({ path: 'become-hub' }, false)).toEqual({
      wizardPath: 'become-hub',
      relayRole: 'relay,node',
      requestedTab: 'hub',
    });
    expect(routeSetupIntent({ path: 'join-hub' }, false).wizardPath).toBe('join-hub');
  });

  test('become-relay：不进 Hub 向导，直接落在中继 tab 并带上角色', () => {
    expect(routeSetupIntent({ path: 'become-relay', role: 'relay' }, false)).toEqual({
      wizardPath: null,
      relayRole: 'relay',
      requestedTab: 'relay',
    });
    // 老记号没带角色时退回中继兼节点。
    expect(routeSetupIntent({ path: 'become-relay' }, false).relayRole).toBe('relay,node');
  });

  test('刚设置完中继：即便没有记号也落在中继 tab', () => {
    expect(routeSetupIntent(null, true).requestedTab).toBe('relay');
  });
});

describe('NodesTab standalone 的中继表单', () => {
  test('中继 tab 里直接摆出「本机作为中继」表单', () => {
    localStatus = status();
    // tab 的初值由 localStorage 记忆推导（`useState` 初始化里读，SSR 也会跑）。
    globalThis.localStorage.setItem('tmex.nodes.uplink-tab', 'relay');
    const html = render({ ...MESH_MODE, mode: 'none' });
    globalThis.localStorage.removeItem('tmex.nodes.uplink-tab');
    expect(html).toContain('data-testid="local-uplink-relay-standalone"');
    expect(html).toContain('data-testid="setup-become-relay-form"');
    // 默认中继兼节点：账号字段在，纯中继的警示不在。
    expect(html).toContain('id="setup-relay-username"');
    expect(html).not.toContain('data-testid="setup-relay-pure-notice"');
  });

  test('mesh 下不摆中继设置表单', () => {
    localStatus = status({ role: 'relay,node' });
    globalThis.localStorage.setItem('tmex.nodes.uplink-tab', 'relay');
    const html = render(MESH_MODE);
    globalThis.localStorage.removeItem('tmex.nodes.uplink-tab');
    expect(html).not.toContain('data-testid="setup-become-relay-form"');
  });
});

describe('待确认记录的取消按钮', () => {
  test('pending 行同时渲染确认与取消按钮', () => {
    localStatus = status({ role: 'hub,node', hubPublicUrl: 'https://hub.example' });
    addPendingEnrollment({
      hubEnrollmentId: 'enr-cancel-1',
      enrollPk: 'pk_base64url',
      authorizationBytes: 'auth_bytes',
      authorizationSig: 'auth_sig',
      exp: Date.now() + 600_000,
      name: 'new-node',
      createdAt: Date.now(),
    });
    const html = render(MESH_MODE);
    expect(html).toContain('data-testid="nodes-pending-confirm-enr-cancel-1"');
    expect(html).toContain('data-testid="nodes-pending-cancel-enr-cancel-1"');
  });
});

describe('NodesTab 模式未落定', () => {
  test('先按版式摆骨架，模式相关区块一概不挂', () => {
    localStatus = status({ role: 'hub,node' });
    resetMeshNodesStateForTest();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NodesTab />
      </MemoryRouter>
    );
    expect(html).toContain('data-testid="settings-nodes-tab-skeleton"');
    expect(html).not.toContain('data-testid="settings-nodes-tab"');
    expect(html).not.toContain('data-testid="local-machine-card"');
    expect(html).not.toContain('data-testid="https-section"');
    expect(html).not.toContain('data-testid="hub-setup-wizard"');
    expect(html).not.toContain('data-testid="nodes-table"');
  });
});
