// 设备管理页：standalone 单面板 vs mesh 按 node 分组（离线 / 未登录 / 已登录三态）。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与侧边栏聚合视图的测试同一套做法）。

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AuthModeResponse, MeshNode } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

// 设备管理面板换成探针：本文件测的是**分组与分支**，面板自身由 packages/panels 覆盖；
// 真实面板要 QueryClient + runtime，而 `src/pages/FilePage.test.tsx` 用 mock.module 全局
// 替换过 `@tanstack/react-query`，真实渲染会被那份泄漏的 mock 打断。
mock.module('@tmex/panels/device-management', () => ({
  DeviceManagementPanel: ({ listenOpenAddDeviceEvent }: { listenOpenAddDeviceEvent?: boolean }) => (
    <span data-testid="device-panel" data-listen={String(listenOpenAddDeviceEvent ?? true)} />
  ),
  DeviceManagementActions: ({ onAddDevice }: { onAddDevice?: () => void }) => (
    <span data-testid="device-actions" data-callback={String(Boolean(onAddDevice))} />
  ),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('@/node/mesh-nodes');
const DevicesPageModule = await import('./DevicesPage');
const DevicesPage = DevicesPageModule.default;
const { PageActions } = DevicesPageModule;
const { nodeDeviceGroupState, toNodeDeviceGroups } = await import('./devices/node-device-group');
const {
  getAddDeviceTargets,
  registerAddDeviceTarget,
  resetAddDeviceTargetsForTest,
  sortAddDeviceTargets,
} = await import('./devices/add-device-targets');

const ENTRY_ID = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const OFFLINE_ID = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';
const SIGNED_OUT_ID = '0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d';
const REMOTE_ID = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';

const MODE: AuthModeResponse = {
  mode: 'mesh',
  nodeId: ENTRY_ID,
  uid: 'user-1',
  username: 'alice',
  kdfParams: { salt: 'AAAAAAAAAAAAAAAAAAAAAA', memory_kib: 65536, iterations: 3, parallelism: 1 },
  passkeysForThisOrigin: false,
  passkeyAvailable: false,
  rootEpoch: 0,
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

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <DevicesPage />
    </MemoryRouter>
  );
}

function renderMeshWith(nodes: MeshNode[]): string {
  setMeshNodesStateForTest({ mode: MODE, modeLoaded: true, entryNodeId: ENTRY_ID, nodes });
  return render();
}

beforeEach(() => {
  resetMeshNodesStateForTest();
  resetAddDeviceTargetsForTest();
});

function target(overrides: { runtimeNodeId: string; name: string; isSelf?: boolean }) {
  return {
    runtimeNodeId: overrides.runtimeNodeId,
    name: overrides.name,
    isSelf: overrides.isSelf ?? false,
    open: () => undefined,
  };
}

describe('toNodeDeviceGroups', () => {
  test('entry 自身排最前并恒为已登录，其余按名称排序', () => {
    const groups = toNodeDeviceGroups(
      [
        meshNode({ id: REMOTE_ID, name: 'studio' }),
        meshNode({ id: OFFLINE_ID, name: 'attic' }),
        meshNode({ id: ENTRY_ID, name: 'zulu', loggedIn: false }),
      ],
      ENTRY_ID
    );
    expect(groups.map((group) => group.runtimeNodeId)).toEqual(['self', OFFLINE_ID, REMOTE_ID]);
    expect(groups[0]).toMatchObject({ id: ENTRY_ID, isSelf: true, loggedIn: true });
  });

  test('entryNodeId 未知时没有 node 被当成 self', () => {
    const groups = toNodeDeviceGroups([meshNode({ id: REMOTE_ID })], null);
    expect(groups[0].isSelf).toBe(false);
    expect(groups[0].runtimeNodeId).toBe(REMOTE_ID);
  });

  test('带出 isHub 与 version 供分组头展示', () => {
    const groups = toNodeDeviceGroups(
      [meshNode({ id: REMOTE_ID, isHub: true, version: '1.2.3' })],
      null
    );
    expect(groups[0]).toMatchObject({ isHub: true, version: '1.2.3' });
  });
});

describe('nodeDeviceGroupState', () => {
  const base = {
    id: REMOTE_ID,
    runtimeNodeId: REMOTE_ID,
    name: 'studio',
    isSelf: false,
    isHub: false,
    version: null,
    inventory: null,
  };

  test('离线优先于登录态', () => {
    expect(nodeDeviceGroupState({ ...base, online: false, loggedIn: true })).toBe('offline');
  });

  test('在线未登录 / 在线已登录', () => {
    expect(nodeDeviceGroupState({ ...base, online: true, loggedIn: false })).toBe('signedOut');
    expect(nodeDeviceGroupState({ ...base, online: true, loggedIn: true })).toBe('ready');
  });
});

describe('DevicesPage', () => {
  test('mode 未加载时只渲染 loading，不建任何运行时', () => {
    const html = render();
    expect(html).not.toContain('data-testid="device-panel"');
    expect(html).not.toContain('data-testid="devices-node-groups"');
    expect(html).toContain('animate-spin');
  });

  test('standalone（mode:none）保持今天的单面板：没有分组也没有节点徽标', () => {
    setMeshNodesStateForTest({ mode: { ...MODE, mode: 'none' }, modeLoaded: true });
    const html = render();
    expect(html).toContain('data-testid="device-panel"');
    expect(html).toContain('data-listen="true"');
    expect(html).not.toContain('data-testid="devices-node-groups"');
    expect(html).not.toContain('data-testid="node-badge-');
  });

  test('mesh 但节点列表还没回来时退回单面板，避免首屏闪空', () => {
    const html = renderMeshWith([]);
    expect(html).toContain('data-testid="device-panel"');
    expect(html).not.toContain('data-testid="devices-node-groups"');
  });

  test('mesh：self 在前，三种节点形态各自渲染', () => {
    const html = renderMeshWith([
      meshNode({
        id: SIGNED_OUT_ID,
        name: 'studio',
        online: true,
        loggedIn: false,
      }),
      meshNode({
        id: OFFLINE_ID,
        name: 'attic',
        online: false,
        inventory: { devices: [{ id: 'd1', name: '书房' }] },
      }),
      meshNode({
        id: ENTRY_ID,
        name: 'entry',
        loggedIn: false,
        isHub: true,
        version: '1.2.3',
      }),
    ]);

    expect(html).toContain('data-testid="devices-node-groups"');
    // self 在最前，且带 Hub 标与版本号
    expect(html.indexOf('devices-node-group-self')).toBeGreaterThan(-1);
    expect(html.indexOf('devices-node-group-self')).toBeLessThan(
      html.indexOf(`devices-node-group-${OFFLINE_ID}`)
    );
    expect(html).toContain('data-testid="devices-node-hub-self"');
    expect(html).toContain('1.2.3');

    // self：在线已登录 → 挂面板，并保留全局事件（外壳右上角的 + 作用于 self）
    expect(html).toContain('data-testid="devices-node-panel-self"');
    expect(html).toContain('data-listen="true"');

    // 离线：灰显最近一次已知 inventory，不挂面板、不给登录按钮
    expect(html).toContain(`data-testid="devices-node-offline-${OFFLINE_ID}"`);
    expect(html).toContain('data-testid="devices-node-offline-device-d1"');
    expect(html).toContain('书房');
    expect(html).not.toContain(`data-testid="devices-node-panel-${OFFLINE_ID}"`);
    expect(html).not.toContain(`data-testid="node-login-${OFFLINE_ID}"`);

    // 在线未登录：只给登录按钮，不挂面板
    expect(html).toContain(`data-testid="devices-node-login-${SIGNED_OUT_ID}"`);
    expect(html).toContain(`data-testid="node-login-${SIGNED_OUT_ID}"`);
    expect(html).not.toContain(`data-testid="devices-node-panel-${SIGNED_OUT_ID}"`);
  });

  test('远端 node 已登录：挂自己的运行时，且关掉全局添加设备事件', () => {
    const html = renderMeshWith([
      meshNode({ id: ENTRY_ID, name: 'entry', loggedIn: true }),
      meshNode({ id: REMOTE_ID, name: 'studio', online: true, loggedIn: true }),
    ]);
    expect(html).toContain(`data-testid="devices-node-panel-${REMOTE_ID}"`);
    expect(html).toContain('data-listen="false"');
    // 每组不再有自己的 +：全页只留顶栏那一个
    expect(html).not.toContain('data-testid="devices-node-add-');
    // 状态徽标：两个 node 都是 ready
    expect(html).toContain(`data-testid="devices-node-status-${REMOTE_ID}"`);
    expect(html).toContain('data-state="ready"');
  });

  test('离线 node 的分组头灰显徽标', () => {
    const html = renderMeshWith([
      meshNode({ id: ENTRY_ID, name: 'entry', loggedIn: true }),
      meshNode({ id: OFFLINE_ID, name: 'attic', online: false }),
    ]);
    expect(html).toContain(`data-testid="node-badge-${OFFLINE_ID}"`);
    expect(html).toContain('data-online="false"');
    expect(html).toContain('data-state="offline"');
    // inventory 为空时给空态
    expect(html).toContain(`data-testid="devices-node-offline-${OFFLINE_ID}"`);
    expect(html).not.toContain('data-testid="devices-node-offline-device-');
  });
});

describe('add-device 目标注册表', () => {
  test('self 排最前，其余按名称排序', () => {
    const sorted = sortAddDeviceTargets([
      target({ runtimeNodeId: REMOTE_ID, name: 'studio' }),
      target({ runtimeNodeId: OFFLINE_ID, name: 'attic' }),
      target({ runtimeNodeId: 'self', name: 'zulu', isSelf: true }),
    ]);
    expect(sorted.map((entry) => entry.runtimeNodeId)).toEqual(['self', OFFLINE_ID, REMOTE_ID]);
  });

  test('登记与注销：注销函数只摘掉自己那一条', () => {
    const first = target({ runtimeNodeId: 'self', name: 'entry', isSelf: true });
    const second = target({ runtimeNodeId: REMOTE_ID, name: 'studio' });
    const unregisterFirst = registerAddDeviceTarget(first);
    registerAddDeviceTarget(second);
    expect(getAddDeviceTargets().map((entry) => entry.runtimeNodeId)).toEqual(['self', REMOTE_ID]);

    unregisterFirst();
    expect(getAddDeviceTargets().map((entry) => entry.runtimeNodeId)).toEqual([REMOTE_ID]);
    // 重复注销不再改动注册表
    unregisterFirst();
    expect(getAddDeviceTargets()).toHaveLength(1);
  });

  test('同一 node 重复登记只保留最后一次（面板重挂不重复出现）', () => {
    registerAddDeviceTarget(target({ runtimeNodeId: REMOTE_ID, name: 'old' }));
    registerAddDeviceTarget(target({ runtimeNodeId: REMOTE_ID, name: 'new' }));
    expect(getAddDeviceTargets()).toHaveLength(1);
    expect(getAddDeviceTargets()[0].name).toBe('new');
  });

  test('快照引用稳定：没有变动时 useSyncExternalStore 不会被判定为新值', () => {
    registerAddDeviceTarget(target({ runtimeNodeId: REMOTE_ID, name: 'studio' }));
    expect(getAddDeviceTargets()).toBe(getAddDeviceTargets());
  });
});

describe('PageActions（全页唯一的 +）', () => {
  test('没有登记目标时退回全局事件按钮（standalone 旧行为）', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PageActions />
      </MemoryRouter>
    );
    expect(html).toContain('data-testid="device-actions"');
    expect(html).toContain('data-callback="false"');
    expect(html).not.toContain('data-testid="devices-add"');
  });

  test('只有一个 ready node 时是直接打开该节点对话框的单按钮', () => {
    registerAddDeviceTarget(target({ runtimeNodeId: 'self', name: 'entry', isSelf: true }));
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PageActions />
      </MemoryRouter>
    );
    expect(html).toContain('data-testid="device-actions"');
    expect(html).toContain('data-callback="true"');
  });

  test('多个 ready node 时换成下拉菜单，触发器仍是 devices-add', () => {
    registerAddDeviceTarget(target({ runtimeNodeId: 'self', name: 'entry', isSelf: true }));
    registerAddDeviceTarget(target({ runtimeNodeId: REMOTE_ID, name: 'studio' }));
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PageActions />
      </MemoryRouter>
    );
    expect(html).toContain('data-testid="devices-add"');
    expect(html).not.toContain('data-testid="device-actions"');
  });
});
