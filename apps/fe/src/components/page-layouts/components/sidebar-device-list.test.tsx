// 侧边栏聚合视图：mesh 列表 → 分节映射，以及三种 node 形态的渲染。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 F4-2 的边界测试同一套做法）。

import { describe, expect, mock, test } from 'bun:test';
import type { MeshNode } from '@tmex/api-client/auth/index';
import type { AppRuntime } from '@tmex/stores';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

// 单个 node 运行时下的设备树（panels 的 SideBarDeviceList）在这里替换成一个探针：
// 本文件测的是**聚合与分支**，设备树本身由 packages/panels 自己的测试覆盖；
// 同时 `src/pages/FilePage.test.tsx` 用 `mock.module` 全局替换了 `@tanstack/react-query`
// （假 QueryClient），真实渲染 panels 列表会被那份泄漏的 mock 打断。
mock.module('./sidebar-device-list-runtime', () => ({
  SideBarDeviceListForRuntime: ({
    section,
  }: {
    section?: { testId: string; header: React.ReactNode };
  }) =>
    section ? (
      <div data-testid={section.testId}>
        {section.header}
        <span data-testid="runtime-device-list" />
      </div>
    ) : (
      <span data-testid="runtime-device-list" />
    ),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { sidebarDeviceVisibilityKey } = await import('@tmex/stores');
const { RuntimeProvider } = await import('@tmex/stores/react');
const {
  SideBarDeviceList,
  applySidebarNodeOrder,
  sidebarNodeIdFromSortableId,
  sidebarNodeSortableId,
  toSidebarEntries,
} = await import('./sidebar-device-list');
const {
  SidebarNodeSection,
  hasSidebarVisibleDeviceForNode,
  inventoryDevices,
  selectedDeviceIdForNode,
} = await import('./sidebar-node-section');
const { SortableVerticalList, useSortableRow } = await import('@tmex/panels/device-tree');

/**
 * 分节自身要读宿主级共享的 UI store（设备可见性）；生产里 AppSidebar 永远在
 * NodeRuntimeBoundary 的 RuntimeProvider 内，这里补一个只带 ui 面的最小 runtime。
 * 不用真 zustand store：静态渲染走 useSyncExternalStore 的 server 快照（zustand 给的是
 * **建店时**的初始 state），建店后再改就读不到，测试无法准备数据。
 */
function runtimeStub(sidebarDeviceVisibility: Record<string, boolean>): AppRuntime {
  const state = { sidebarDeviceVisibility };
  const ui = <T,>(selector: (value: typeof state) => T): T => selector(state);
  return { nodeId: 'self', stores: { ui } } as unknown as AppRuntime;
}

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

function render(
  ui: React.ReactNode,
  visibility: Record<string, boolean> = {},
  entry = '/'
): string {
  return renderToStaticMarkup(
    <RuntimeProvider runtime={runtimeStub(visibility)}>
      <MemoryRouter initialEntries={[entry]}>{ui}</MemoryRouter>
    </RuntimeProvider>
  );
}

describe('toSidebarEntries', () => {
  test('entry 自身映射成 self 并恒为已登录（本地 UI 已过 guard）', () => {
    const entries = toSidebarEntries(
      [
        meshNode({
          id: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
          name: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
          loggedIn: false,
        }),
        meshNode({ id: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c' }),
      ],
      '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e'
    );
    expect(entries[0]).toMatchObject({
      id: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
      runtimeNodeId: 'self',
      isSelf: true,
      loggedIn: true,
    });
    expect(entries[1]).toMatchObject({
      id: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c',
      runtimeNodeId: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c',
      isSelf: false,
    });
  });

  test('entryNodeId 未知时没有 node 被当成 self', () => {
    const entries = toSidebarEntries([meshNode({ id: 'a' })], null);
    expect(entries[0].isSelf).toBe(false);
    expect(entries[0].runtimeNodeId).toBe('a');
  });

  test('手工顺序优先于 API 顺序，新 node 追加在末尾', () => {
    const nodes = [meshNode({ id: 'a' }), meshNode({ id: 'b' }), meshNode({ id: 'c' })];
    expect(toSidebarEntries(nodes, null, ['c', 'gone', 'a']).map((e) => e.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  test('手工顺序用的是 mesh node id，self 也能被拖到别的位置', () => {
    const nodes = [meshNode({ id: 'a' }), meshNode({ id: 'b' })];
    const entries = toSidebarEntries(nodes, 'a', ['b', 'a']);
    expect(entries.map((e) => e.id)).toEqual(['b', 'a']);
    expect(entries[1].runtimeNodeId).toBe('self');
  });

  test('缺省顺序现算：API 把 self 放最后也排到最前，离线的排在在线的后面', () => {
    // `/api/mesh/nodes` 的返回是原样落进 store 的，侧栏不能指望它已经排好序
    const nodes = [
      meshNode({ id: 'c', name: 'c' }),
      meshNode({ id: 'b', name: 'b', online: false }),
      meshNode({ id: 'a', name: 'a' }),
    ];
    expect(toSidebarEntries(nodes, 'a').map((e) => e.id)).toEqual(['a', 'c', 'b']);
  });

  test('self 被拖到中间 / 末尾后顺序稳住，不会被缺省顺序拉回最前', () => {
    const nodes = [meshNode({ id: 'a' }), meshNode({ id: 'b' }), meshNode({ id: 'c' })];
    expect(toSidebarEntries(nodes, 'a', ['b', 'a', 'c']).map((e) => e.id)).toEqual(['b', 'a', 'c']);
    expect(toSidebarEntries(nodes, 'a', ['b', 'c', 'a']).map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  test('self 排在末尾时新加入的 node 追加在它后面，self 位置不变', () => {
    const nodes = [meshNode({ id: 'a' }), meshNode({ id: 'b' }), meshNode({ id: 'd' })];
    expect(toSidebarEntries(nodes, 'a', ['b', 'a']).map((e) => e.id)).toEqual(['b', 'a', 'd']);
  });
});

describe('applySidebarNodeOrder', () => {
  const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as unknown as Parameters<
    typeof applySidebarNodeOrder
  >[0];

  test('空顺序原样返回 API 顺序', () => {
    expect(applySidebarNodeOrder(entries, []).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  test('保存过的 id 按保存顺序在前，新 node 按 API 顺序追加在后', () => {
    expect(applySidebarNodeOrder(entries, ['c', 'a']).map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });

  test('已不存在的 id 直接跳过，重复 id 只算一次', () => {
    expect(applySidebarNodeOrder(entries, ['gone', 'b', 'b', 'gone2']).map((e) => e.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  test('顺序覆盖全部 node 时完全按保存顺序', () => {
    expect(applySidebarNodeOrder(entries, ['c', 'b', 'a']).map((e) => e.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });
});

describe('sidebar node sortable ids', () => {
  test('加前缀与还原互为逆运算，与设备/窗口/pane 的 id 空间隔开', () => {
    expect(sidebarNodeSortableId('node-1')).toBe('sidebar-node:node-1');
    expect(sidebarNodeIdFromSortableId(sidebarNodeSortableId('node-1'))).toBe('node-1');
  });

  test('没有前缀的 id 原样返回', () => {
    expect(sidebarNodeIdFromSortableId('node-1')).toBe('node-1');
  });
});

describe('inventoryDevices', () => {
  test('取 inventory.devices 里的 {id,name}，缺 name 用 id', () => {
    expect(inventoryDevices({ devices: [{ id: 'd1', name: '书房' }, { id: 'd2' }] })).toEqual([
      { id: 'd1', name: '书房' },
      { id: 'd2', name: 'd2' },
    ]);
  });

  test('非法 inventory 一律空数组', () => {
    expect(inventoryDevices(null)).toEqual([]);
    expect(inventoryDevices('nope')).toEqual([]);
    expect(inventoryDevices({ devices: 'nope' })).toEqual([]);
  });
});

describe('hasSidebarVisibleDeviceForNode', () => {
  test('只认该 node 前缀下显式打开的设备', () => {
    const visibility = {
      [sidebarDeviceVisibilityKey('node-a', 'd1')]: false,
      [sidebarDeviceVisibilityKey('node-b', 'd1')]: true,
    };
    expect(hasSidebarVisibleDeviceForNode(visibility, 'node-a')).toBe(false);
    expect(hasSidebarVisibleDeviceForNode(visibility, 'node-b')).toBe(true);
    expect(hasSidebarVisibleDeviceForNode({}, 'node-b')).toBe(false);
  });

  test('id 互为前缀的 node 不会互相带出来', () => {
    const visibility = { [sidebarDeviceVisibilityKey('node-ab', 'd1')]: true };
    expect(hasSidebarVisibleDeviceForNode(visibility, 'node-a')).toBe(false);
    expect(hasSidebarVisibleDeviceForNode(visibility, 'node-ab')).toBe(true);
  });
});

describe('SidebarNodeSection', () => {
  const OFFLINE_NODE = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';

  function offlineNode() {
    return {
      id: OFFLINE_NODE,
      runtimeNodeId: OFFLINE_NODE,
      name: 'studio',
      online: false,
      loggedIn: true,
      isSelf: false,
      inventory: { devices: [{ id: 'd1', name: '书房' }] },
    };
  }

  test('离线 node：已知设备默认全不显示时整节都不渲染（连分节头一起）', () => {
    const html = render(<SidebarNodeSection node={offlineNode()} />);

    expect(html).not.toContain(`data-testid="sidebar-node-offline-${OFFLINE_NODE}"`);
    expect(html).not.toContain(`data-testid="node-badge-${OFFLINE_NODE}"`);
    expect(html).not.toContain('data-testid="sidebar-node-offline-device-d1"');
    expect(html).not.toContain('data-testid="device-item-');
  });

  test('离线远端 node：一台已知设备都没有时整节不渲染', () => {
    const html = render(<SidebarNodeSection node={{ ...offlineNode(), inventory: null }} />);

    expect(html).not.toContain(`data-testid="sidebar-node-offline-${OFFLINE_NODE}"`);
    expect(html).not.toContain(`data-testid="node-badge-${OFFLINE_NODE}"`);
  });

  test('离线 self：一台已知设备都没有时保留分节头与提示', () => {
    const html = render(
      <SidebarNodeSection node={{ ...offlineNode(), isSelf: true, inventory: null }} />
    );

    expect(html).toContain(`data-testid="sidebar-node-offline-${OFFLINE_NODE}"`);
    expect(html).toContain('data-online="false"');
    expect(html).not.toContain('data-testid="device-item-');
  });

  test('离线 node：勾选显示后灰显已知设备，链接带 /n/<id> 前缀，不建连接', () => {
    const html = render(<SidebarNodeSection node={offlineNode()} />, {
      [sidebarDeviceVisibilityKey(OFFLINE_NODE, 'd1')]: true,
    });

    expect(html).toContain('data-testid="sidebar-node-offline-device-d1"');
    expect(html).toContain(`href="/n/${OFFLINE_NODE}/devices/d1"`);
    expect(html).toContain('书房');
    expect(html).not.toContain('data-testid="device-item-');
  });

  test('可见的离线分节首屏就在且不透明：presence 外壳既不推迟渲染也不淡入一遍', () => {
    const html = render(<SidebarNodeSection node={offlineNode()} />, {
      [sidebarDeviceVisibilityKey(OFFLINE_NODE, 'd1')]: true,
    });

    expect(html).toContain(`data-testid="sidebar-node-offline-${OFFLINE_NODE}"`);
    const section = html.slice(html.indexOf(`data-testid="sidebar-node-offline-${OFFLINE_NODE}"`));
    expect(section.slice(0, section.indexOf('>'))).toContain('opacity-100');
  });

  test('离线 node：当前选中的那台设备无条件保留（与在线选择器同一条例外）', () => {
    const html = render(
      <SidebarNodeSection node={offlineNode()} />,
      {},
      `/n/${OFFLINE_NODE}/devices/d1`
    );

    expect(html).toContain('data-testid="sidebar-node-offline-device-d1"');
  });

  test('离线 node：别的 node 上选中的同名设备不算数', () => {
    const html = render(<SidebarNodeSection node={offlineNode()} />, {}, '/devices/d1');
    expect(html).not.toContain('data-testid="sidebar-node-offline-device-d1"');
    expect(html).not.toContain(`data-testid="sidebar-node-offline-${OFFLINE_NODE}"`);
  });

  function signedOutNode() {
    return {
      id: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c',
      runtimeNodeId: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c',
      name: 'studio',
      online: true,
      loggedIn: false,
      isSelf: false,
      inventory: null,
    };
  }

  test('在线但未登录：一台设备都没开侧边栏显示时整节不渲染（登录入口只在「管理设备」里）', () => {
    const html = render(<SidebarNodeSection node={signedOutNode()} />);

    expect(html).not.toContain('data-testid="sidebar-node-login-');
    expect(html).not.toContain('data-testid="sidebar-node-expand-');
    expect(html).not.toContain('data-testid="node-badge-0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"');
  });

  test('在线但未登录：开过设备显示的 node 保留紧凑登录行，不自动登录、不渲染设备树', () => {
    const html = render(<SidebarNodeSection node={signedOutNode()} />, {
      [sidebarDeviceVisibilityKey('0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c', 'd1')]: true,
    });

    expect(html).toContain('data-testid="sidebar-node-login-0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"');
    // 折叠态：只有「展开并登录」这一个入口，既没有设备树也没有登录中的转圈
    expect(html).toContain('data-testid="sidebar-node-expand-0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"');
    expect(html).not.toContain('data-testid="sidebar-node-pending-');
    expect(html).not.toContain('data-testid="runtime-device-list"');
    expect(html).not.toContain('data-testid="device-item-');
  });

  test('在线但未登录：设备显示被关掉（显式 false）同样整节不渲染', () => {
    const html = render(<SidebarNodeSection node={signedOutNode()} />, {
      [sidebarDeviceVisibilityKey('0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c', 'd1')]: false,
      // 别的 node 开着的设备不能把这一节带出来
      [sidebarDeviceVisibilityKey('0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d', 'd2')]: true,
    });

    expect(html).not.toContain('data-testid="sidebar-node-login-');
  });

  test('在线但未登录：正在浏览该 node 的某台设备时保留登录行', () => {
    const html = render(
      <SidebarNodeSection node={signedOutNode()} />,
      {},
      '/n/0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c/devices/d1'
    );

    expect(html).toContain('data-testid="sidebar-node-login-0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"');
  });

  test('在线且已登录：挂该 node 的运行时并渲染设备树', () => {
    const html = render(
      <SidebarNodeSection
        node={{
          id: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c',
          runtimeNodeId: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c',
          name: 'studio',
          online: true,
          loggedIn: true,
          isSelf: false,
          inventory: null,
        }}
      />
    );
    expect(html).toContain('data-testid="sidebar-node-0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"');
    expect(html).toContain('data-testid="node-badge-0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"');
    expect(html).toContain('data-online="true"');
    // 设备树与分节头一起挂在该 node 的运行时下
    expect(html).toContain('data-testid="runtime-device-list"');
  });
});

describe('分节拖拽接线', () => {
  const NODE = '0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d';
  const DRAG_LABEL = '拖动以调整节点顺序';

  // 生产里 `MeshDeviceList` 就是这么接的：分节 id 加 `sidebar-node:` 前缀，
  // 与分节内部设备/窗口/pane 三层排序的 id 空间隔开。
  function SortableProbe({ node }: { node: Parameters<typeof SidebarNodeSection>[0]['node'] }) {
    const sortable = useSortableRow(sidebarNodeSortableId(node.id));
    return <SidebarNodeSection node={node} drag={{ sortable, dragHandleLabel: DRAG_LABEL }} />;
  }

  test('分节头兼作拖拽手柄：可拖拽属性挂在 header 上，节点名不再是带框徽标', () => {
    const node = {
      id: NODE,
      runtimeNodeId: NODE,
      name: 'studio',
      online: false,
      loggedIn: true,
      isSelf: true,
      inventory: null,
    };
    const html = render(
      <SortableVerticalList ids={[sidebarNodeSortableId(NODE)]} onReorder={() => {}}>
        <SortableProbe node={node} />
      </SortableVerticalList>
    );

    expect(html).toContain(`data-testid="sidebar-node-header-${NODE}"`);
    expect(html).toContain(`aria-label="${DRAG_LABEL}"`);
    expect(html).toContain('cursor-grab');
    expect(html).toContain('data-variant="plain"');
    expect(html).not.toContain('border-border/60');
  });
});

describe('selectedDeviceIdForNode', () => {
  const NODE = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';

  test('只认前缀匹配的那个 node', () => {
    expect(selectedDeviceIdForNode(`/n/${NODE}/devices/d1`, NODE)).toBe('d1');
    expect(selectedDeviceIdForNode(`/n/${NODE}/devices/d1`, 'self')).toBeNull();
    expect(selectedDeviceIdForNode('/devices/d1', 'self')).toBe('d1');
    expect(selectedDeviceIdForNode('/devices/d1', NODE)).toBeNull();
  });

  test('窗口 / pane 深链同样算选中了那台设备，别的路由不算', () => {
    expect(selectedDeviceIdForNode('/devices/d1/windows/w1/panes/p1', 'self')).toBe('d1');
    expect(selectedDeviceIdForNode('/settings?tab=nodes', 'self')).toBeNull();
    expect(selectedDeviceIdForNode('/devices', 'self')).toBeNull();
  });

  test('设备 id 在链接里是 URL 编码的，解回原值再比', () => {
    expect(selectedDeviceIdForNode('/devices/a%2Fb', 'self')).toBe('a/b');
    // 坏掉的 % 序列不能让整棵侧边栏崩掉
    expect(selectedDeviceIdForNode('/devices/%zz', 'self')).toBe('%zz');
  });
});

describe('SideBarDeviceList', () => {
  test('standalone / mode 未知时渲染今天的单 node 设备树：没有 node 分节也没有徽标', () => {
    const html = render(<SideBarDeviceList />);
    expect(html).toContain('data-testid="runtime-device-list"');
    expect(html).not.toContain('data-testid="sidebar-node-list"');
    expect(html).not.toContain('data-testid="node-badge-');
    expect(html).not.toContain('data-testid="sidebar-node-header-');
  });
});
