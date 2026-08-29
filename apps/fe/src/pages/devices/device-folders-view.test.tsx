// 分组列表 ←→ 节点分组的映射。无 DOM 环境，用 react-dom/server 静态渲染
// （与 DevicesPage.test.tsx、侧边栏聚合视图的测试同一套做法）。

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { DeviceFolderLayout } from '@tmex/shared';
import type { AppRuntime } from '@tmex/stores';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

// 面板换成探针：本文件测的是映射（谁进了哪个分组、把手落在哪里），
// 面板 / 卡片自身由 packages/panels 覆盖。
mock.module('@tmex/panels/device-management', () => ({
  DeviceManagementPanel: ({
    listenOpenAddDeviceEvent,
    offline,
    fallbackDevices,
  }: {
    listenOpenAddDeviceEvent?: boolean;
    offline?: boolean;
    fallbackDevices?: readonly { id: string }[];
  }) => (
    <span
      data-testid="device-panel"
      data-listen={String(listenOpenAddDeviceEvent ?? true)}
      data-offline={String(offline ?? false)}
      data-fallback={(fallbackDevices ?? []).map((device) => device.id).join(',')}
    />
  ),
  DeviceManagementActions: ({ onAddDevice }: { onAddDevice?: () => void }) => (
    <span data-testid="device-actions" data-callback={String(Boolean(onAddDevice))} />
  ),
}));

let layout: DeviceFolderLayout = { folders: [], placements: [] };
const submitted: (DeviceFolderLayout | null)[] = [];

mock.module('./use-device-folders', () => ({
  useDeviceFolders: () => ({
    layout,
    isLoading: false,
    isError: false,
    pending: false,
    layoutBusy: false,
    submitLayout: (next: DeviceFolderLayout | null) => submitted.push(next),
    moveNodeToRoot: () => undefined,
    createFolder: () => undefined,
    renameFolder: () => undefined,
    deleteFolder: () => undefined,
    resetLayout: () => undefined,
    refetch: () => undefined,
  }),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { RuntimeProvider } = await import('@tmex/stores/react');
const { DeviceFoldersView, nodeCandidates } = await import('./device-folders-view');

const REMOTE_ID = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
const OFFLINE_ID = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';

type Group = Parameters<typeof DeviceFoldersView>[0]['groups'][number];

function group(overrides: Partial<Group> & { runtimeNodeId: string }): Group {
  return {
    id: overrides.runtimeNodeId,
    name: overrides.runtimeNodeId,
    online: true,
    loggedIn: true,
    isSelf: false,
    isHub: false,
    version: null,
    inventory: null,
    ...overrides,
  };
}

const SELF = group({ runtimeNodeId: 'self', name: 'entry', isSelf: true });
const REMOTE = group({ runtimeNodeId: REMOTE_ID, name: 'studio' });
const OFFLINE = group({
  runtimeNodeId: OFFLINE_ID,
  name: 'attic',
  online: false,
  inventory: { devices: [{ id: 'd9', name: '阁楼' }] },
});

function folder(id: string) {
  return {
    id,
    name: `folder-${id}`,
    sortOrder: 0,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
}

function runtimeStub(): AppRuntime {
  const state = {
    deviceFolderExpanded: {} as Record<string, boolean>,
    setDeviceFolderExpanded: () => undefined,
  };
  const ui = <T,>(selector: (value: typeof state) => T): T => selector(state);
  return { nodeId: 'self', stores: { ui } } as unknown as AppRuntime;
}

function render(groups: Group[], showNodeHeaders: boolean): string {
  return renderToStaticMarkup(
    <RuntimeProvider runtime={runtimeStub()}>
      <MemoryRouter>
        <DeviceFoldersView groups={groups} showNodeHeaders={showNodeHeaders} />
      </MemoryRouter>
    </RuntimeProvider>
  );
}

function slice(html: string, testId: string): string {
  const start = html.indexOf(`data-testid="${testId}"`);
  const next = html.indexOf('data-testid="device-folder-item-', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

beforeEach(() => {
  localStorage.clear();
  submitted.length = 0;
});

describe('nodeCandidates', () => {
  test('按分组顺序生成节点 id（self 在前由 toNodeDeviceGroups 决定）', () => {
    expect(nodeCandidates([SELF, OFFLINE, REMOTE])).toEqual(['self', OFFLINE_ID, REMOTE_ID]);
  });
});

describe('DeviceFoldersView', () => {
  test('没有任何 placement 时全部节点按分组顺序排在根层', () => {
    layout = { folders: [], placements: [] };
    const html = render([SELF, OFFLINE, REMOTE], true);

    expect(html).toContain('data-testid="devices-folders-view"');
    expect(html.indexOf('data-testid="device-folder-item-node:self"')).toBeLessThan(
      html.indexOf(`data-testid="device-folder-item-node:${OFFLINE_ID}"`)
    );
    expect(html.indexOf(`data-testid="device-folder-item-node:${OFFLINE_ID}"`)).toBeLessThan(
      html.indexOf(`data-testid="device-folder-item-node:${REMOTE_ID}"`)
    );
    // mesh 下每个分组都有分组头
    expect(html).toContain('data-testid="devices-node-header-self"');
  });

  test('被放进分组的节点从根层消失，出现在分组里；把手落在节点头部', () => {
    layout = {
      folders: [folder('a')],
      placements: [{ nodeId: REMOTE_ID, folderId: 'a', sortOrder: 0 }],
    };
    const html = render([SELF, REMOTE], true);

    expect(html).toContain('data-testid="device-folder-a"');
    const folderIndex = html.indexOf('data-testid="device-folder-a"');
    const remoteIndex = html.indexOf(`data-testid="device-folder-item-node:${REMOTE_ID}"`);
    const selfIndex = html.indexOf('data-testid="device-folder-item-node:self"');
    // 分组整体排在根层节点之前，被放进去的节点在分组内部
    expect(folderIndex).toBeLessThan(remoteIndex);
    expect(remoteIndex).toBeLessThan(selfIndex);

    const remote = slice(html, `device-folder-item-node:${REMOTE_ID}`);
    const header = remote.indexOf(`data-testid="devices-node-header-${REMOTE_ID}"`);
    const handle = remote.indexOf(`data-testid="device-folder-handle-${REMOTE_ID}"`);
    const panel = remote.indexOf('data-testid="device-panel"');
    expect(header).toBeGreaterThan(-1);
    expect(handle).toBeGreaterThan(header);
    expect(handle).toBeLessThan(panel);
    // 分组内的节点额外给一个「移出分组」的入口
    expect(remote).toContain(`data-testid="device-folder-move-out-${REMOTE_ID}"`);
  });

  test('离线节点保留运行时与卡片面板（offline 模式），兜底设备来自 inventory', () => {
    layout = { folders: [], placements: [] };
    const html = render([SELF, OFFLINE], true);

    const offline = slice(html, `device-folder-item-node:${OFFLINE_ID}`);
    expect(offline).toContain(`data-testid="devices-node-panel-${OFFLINE_ID}"`);
    expect(offline).toContain('data-offline="true"');
    expect(offline).toContain('data-fallback="d9"');
    expect(submitted).toHaveLength(0);
  });

  test('离线节点优先用本地快照', () => {
    localStorage.setItem(
      `tmex:device-snapshot:${OFFLINE_ID}`,
      JSON.stringify([{ id: 'snap', name: '快照', type: 'local', sortOrder: 0 }])
    );
    layout = { folders: [], placements: [] };
    const html = render([SELF, OFFLINE], true);
    expect(slice(html, `device-folder-item-node:${OFFLINE_ID}`)).toContain('data-fallback="snap"');
  });

  test('mesh 列表里已经没有的节点不渲染，也不改布局', () => {
    layout = {
      folders: [folder('a')],
      placements: [{ nodeId: 'ghost', folderId: 'a', sortOrder: 0 }],
    };
    const html = render([SELF], true);

    expect(html).toContain('data-testid="device-folder-a"');
    expect(html).not.toContain('data-testid="device-folder-item-node:ghost"');
    expect(submitted).toHaveLength(0);
  });

  test('standalone：根层的本机条目不套拖拽把手，也没有分组头', () => {
    layout = { folders: [], placements: [] };
    const html = render([SELF], false);

    expect(html).toContain('data-testid="device-panel"');
    expect(html).toContain('data-testid="device-folder-item-node:self"');
    expect(html).not.toContain('data-testid="devices-node-header-self"');
    expect(html).not.toContain('devices.folders.dragHandle');
  });

  test('standalone 下进了分组的节点仍然可以拖回去', () => {
    layout = {
      folders: [folder('a')],
      placements: [{ nodeId: 'self', folderId: 'a', sortOrder: 0 }],
    };
    const html = render([SELF], false);

    expect(html).toContain('data-testid="device-folder-item-node:self"');
    expect(html).toContain('data-testid="device-folder-handle-self"');
    expect(html).toContain('data-testid="device-folder-move-out-self"');
  });

  test('页面级容器不在这里：主体只是 w-full，不再套 max-width / padding', () => {
    layout = { folders: [], placements: [] };
    const html = render([SELF], false);
    const start = html.indexOf('data-testid="devices-folders-view"');
    const tag = html.slice(html.lastIndexOf('<', start), html.indexOf('>', start));
    expect(tag).not.toContain('max-w-');
    expect(tag).not.toMatch(/\b(p|px|py)-\d/);
  });
});
