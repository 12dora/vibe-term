// 侧边栏聚合视图：mesh 列表 → 分节映射，以及三种 node 形态的渲染。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 F4-2 的边界测试同一套做法）。

import { describe, expect, mock, test } from 'bun:test';
import type { MeshNode } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

// 单个 node 运行时下的设备树（panels 的 SideBarDeviceList）在这里替换成一个探针：
// 本文件测的是**聚合与分支**，设备树本身由 packages/panels 自己的测试覆盖；
// 同时 `src/pages/FilePage.test.tsx` 用 `mock.module` 全局替换了 `@tanstack/react-query`
// （假 QueryClient），真实渲染 panels 列表会被那份泄漏的 mock 打断。
mock.module('./sidebar-device-list-runtime', () => ({
  SideBarDeviceListForRuntime: ({ nodeBadge }: { nodeBadge?: { nodeId: string } }) => (
    <span data-testid="runtime-device-list" data-node={nodeBadge?.nodeId ?? ''} />
  ),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { SideBarDeviceList, toSidebarEntries } = await import('./sidebar-device-list');
const { SidebarNodeSection, inventoryDevices } = await import('./sidebar-node-section');

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

function render(ui: React.ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter>{ui}</MemoryRouter>);
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

describe('SidebarNodeSection', () => {
  test('离线 node：灰显最近一次已知 inventory，链接带 /n/<id> 前缀，不建连接', () => {
    const html = render(
      <SidebarNodeSection
        node={{
          id: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c',
          runtimeNodeId: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c',
          name: 'studio',
          online: false,
          loggedIn: true,
          isSelf: false,
          inventory: { devices: [{ id: 'd1', name: '书房' }] },
        }}
      />
    );
    expect(html).toContain('data-testid="sidebar-node-offline-0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"');
    expect(html).toContain('data-testid="sidebar-node-offline-device-d1"');
    expect(html).toContain('href="/n/0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c/devices/d1"');
    expect(html).toContain('书房');
    // 徽标灰显
    expect(html).toContain('data-testid="node-badge-0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"');
    expect(html).toContain('data-online="false"');
    // 未渲染任何设备树
    expect(html).not.toContain('data-testid="device-item-');
  });

  test('在线但未登录：只渲染登录按钮，不渲染设备树', () => {
    const html = render(
      <SidebarNodeSection
        node={{
          id: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c',
          runtimeNodeId: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c',
          name: 'studio',
          online: true,
          loggedIn: false,
          isSelf: false,
          inventory: null,
        }}
      />
    );
    expect(html).toContain('data-testid="sidebar-node-login-0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"');
    expect(html).toContain('data-testid="node-login-0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"');
    expect(html).not.toContain('data-testid="device-item-');
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
    // 设备树挂在该 node 的运行时下，且拿到了 node 徽标
    expect(html).toContain('data-testid="runtime-device-list"');
    expect(html).toContain('data-node="0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"');
  });
});

describe('SideBarDeviceList', () => {
  test('standalone / mode 未知时渲染今天的单 node 设备树：没有 node 分节也没有徽标', () => {
    const html = render(<SideBarDeviceList />);
    expect(html).toContain('data-testid="runtime-device-list"');
    expect(html).toContain('data-node=""');
    expect(html).not.toContain('data-testid="sidebar-node-list"');
    expect(html).not.toContain('data-testid="node-badge-');
    expect(html).not.toContain('data-testid="sidebar-node-header-');
  });
});
