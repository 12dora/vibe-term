// 文件夹树 ←→ 节点分组 / 单卡的映射。无 DOM 环境，用 react-dom/server 静态渲染
// （与 DevicesPage.test.tsx、侧边栏聚合视图的测试同一套做法）。

import { describe, expect, mock, test } from 'bun:test';
import type { DeviceFolderLayout } from '@tmex/shared';
import type { AppRuntime } from '@tmex/stores';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

// 面板与单卡换成探针：本文件测的是映射（谁被排除、谁进了哪个文件夹），
// 面板 / 卡片自身由 packages/panels 覆盖。
mock.module('@tmex/panels/device-management', () => ({
  DeviceManagementPanel: ({
    listenOpenAddDeviceEvent,
    excludeDeviceIds,
  }: {
    listenOpenAddDeviceEvent?: boolean;
    excludeDeviceIds?: ReadonlySet<string>;
  }) => (
    <span
      data-testid="device-panel"
      data-listen={String(listenOpenAddDeviceEvent ?? true)}
      data-excluded={[...(excludeDeviceIds ?? [])].join(',')}
    />
  ),
  DeviceManagementActions: ({ onAddDevice }: { onAddDevice?: () => void }) => (
    <span data-testid="device-actions" data-callback={String(Boolean(onAddDevice))} />
  ),
  DeviceCardHost: ({ device }: { device: { id: string } }) => (
    <span data-testid={`device-card-host-${device.id}`} />
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
    submitLayout: (next: DeviceFolderLayout | null) => submitted.push(next),
    moveItemToRoot: () => undefined,
    createFolder: () => undefined,
    renameFolder: () => undefined,
    deleteFolder: () => undefined,
    refetch: () => undefined,
  }),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { RuntimeProvider } = await import('@tmex/stores/react');
const { DeviceFoldersView, nodeItemCandidates } = await import('./device-folders-view');

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
const OFFLINE = group({ runtimeNodeId: OFFLINE_ID, name: 'attic', online: false });

function folder(id: string) {
  return {
    id,
    name: `folder-${id}`,
    parentId: null,
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

describe('nodeItemCandidates', () => {
  test('按分组顺序生成 node 条目（self 在前由 toNodeDeviceGroups 决定）', () => {
    expect(nodeItemCandidates([SELF, OFFLINE, REMOTE])).toEqual([
      { kind: 'node', nodeId: 'self', deviceId: null },
      { kind: 'node', nodeId: OFFLINE_ID, deviceId: null },
      { kind: 'node', nodeId: REMOTE_ID, deviceId: null },
    ]);
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

  test('被放进文件夹的节点从根层消失，出现在文件夹里', () => {
    layout = {
      folders: [folder('a')],
      placements: [
        { kind: 'node', nodeId: REMOTE_ID, deviceId: null, folderId: 'a', sortOrder: 0 },
      ],
    };
    const html = render([SELF, REMOTE], true);

    expect(html).toContain('data-testid="device-folder-a"');
    const folderIndex = html.indexOf('data-testid="device-folder-a"');
    const remoteIndex = html.indexOf(`data-testid="device-folder-item-node:${REMOTE_ID}"`);
    const selfIndex = html.indexOf('data-testid="device-folder-item-node:self"');
    // 文件夹整体排在根层条目之前，被放进去的节点在文件夹内部
    expect(folderIndex).toBeLessThan(remoteIndex);
    expect(remoteIndex).toBeLessThan(selfIndex);
  });

  test('被单独放置的设备从所属节点的卡片网格里排除', () => {
    layout = {
      folders: [folder('a')],
      placements: [{ kind: 'device', nodeId: 'self', deviceId: 'd1', folderId: 'a', sortOrder: 0 }],
    };
    const html = render([SELF], true);

    expect(html).toContain('data-excluded="d1"');
    expect(html).toContain('data-testid="device-folder-item-device:self:d1"');
  });

  test('节点不可用时被放置的设备渲染灰色占位，且不改布局', () => {
    layout = {
      folders: [folder('a')],
      placements: [
        { kind: 'device', nodeId: OFFLINE_ID, deviceId: 'd9', folderId: 'a', sortOrder: 0 },
      ],
    };
    const html = render([SELF, OFFLINE], true);

    expect(html).toContain(`data-testid="device-folder-missing-device:${OFFLINE_ID}:d9"`);
    expect(html).toContain('devices.folders.missingDevice');
    expect(html).toContain('attic · d9');
    expect(submitted).toHaveLength(0);
  });

  test('mesh 列表里已经没有的节点不渲染，也不改布局', () => {
    layout = {
      folders: [folder('a')],
      placements: [{ kind: 'node', nodeId: 'ghost', deviceId: null, folderId: 'a', sortOrder: 0 }],
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

  test('standalone 下文件夹里的条目仍然可以拖回去', () => {
    layout = {
      folders: [folder('a')],
      placements: [{ kind: 'device', nodeId: 'self', deviceId: 'd1', folderId: 'a', sortOrder: 0 }],
    };
    const html = render([SELF], false);

    expect(html).toContain('data-testid="device-folder-item-device:self:d1"');
    expect(html).toContain('devices.folders.dragHandle');
    // 文件夹内的条目额外给一个「移出文件夹」的入口
    expect(html).toContain('devices.folders.moveToRoot');
  });
});
