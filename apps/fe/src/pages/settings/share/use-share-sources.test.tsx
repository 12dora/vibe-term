// 分享来源的节点清单：成员列表还在同步时不能把本机当成唯一来源。
// 无 DOM 测试环境，用 react-dom/server 静态渲染一个只读探针（与设置页其余用例同一套做法）。

import { describe, expect, test } from 'bun:test';
import type { AuthModeResponse, MeshNode } from '@vibeterm/api-client/auth/index';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('@/node/mesh-nodes');
const { useShareNodes } = await import('./use-share-sources');

const ENTRY_ID = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const REMOTE_ID = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';

const MESH_MODE: AuthModeResponse = {
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
    loggedIn: true,
    ...overrides,
  };
}

function Probe() {
  const model = useShareNodes();
  return (
    <span
      data-testid="share-nodes"
      data-options={model.options.map((option) => option.id).join(',')}
      data-usable={model.usable.map((option) => option.id).join(',')}
      data-multi={String(model.multiNode)}
    />
  );
}

type MeshStateOverrides = Parameters<typeof setMeshNodesStateForTest>[0];

function render(overrides: MeshStateOverrides = {}): string {
  resetMeshNodesStateForTest();
  setMeshNodesStateForTest({
    mode: MESH_MODE,
    modeLoaded: true,
    entryNodeId: ENTRY_ID,
    loadedAt: 1,
    pendingMembers: 0,
    ...overrides,
  });
  return renderToStaticMarkup(<Probe />);
}

describe('useShareNodes', () => {
  test('成员列表还在同步：一个来源都不给，不把本机当成唯一节点', () => {
    const html = render({ nodes: [], loadedAt: null, pendingMembers: null });
    expect(html).toContain('data-options=""');
    expect(html).toContain('data-usable=""');
    expect(html).toContain('data-multi="false"');
  });

  test('列表已到但还有成员在同步：同样不给来源', () => {
    const html = render({
      nodes: [meshNode({ id: ENTRY_ID, name: 'entry' })],
      pendingMembers: 1,
    });
    expect(html).toContain('data-options=""');
  });

  test('列表到齐：本机在前，可用的都列出来', () => {
    const html = render({
      nodes: [meshNode({ id: REMOTE_ID, name: 'studio' }), meshNode({ id: ENTRY_ID, name: 'a' })],
    });
    expect(html).toContain(`data-options="self,${REMOTE_ID}"`);
    expect(html).toContain(`data-usable="self,${REMOTE_ID}"`);
    expect(html).toContain('data-multi="true"');
  });

  test('standalone：恒为本机一个来源', () => {
    const html = render({ mode: { ...MESH_MODE, mode: 'none' }, nodes: [], loadedAt: null });
    expect(html).toContain('data-options="self"');
    expect(html).toContain('data-multi="false"');
  });
});
