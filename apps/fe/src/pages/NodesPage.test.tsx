// Nodes 页的静态渲染：standalone 不渲染、表格列与合并结果、hub 离线时管理动作禁用。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuthModeResponse, MeshNode } from '@tmex/api-client/auth/index';
import { encodeBase64url } from '@tmex/shared/auth';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('@/node/mesh-nodes');
const { setPendingStorage, clearPendingEnrollments } = await import('@/node/enrollment');
const NodesPage = (await import('./NodesPage')).default;

const MODE: AuthModeResponse = {
  mode: 'mesh',
  nodeId: 'entry-1',
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
    publicKey: encodeBase64url(new Uint8Array(32).fill(5)),
    online: true,
    reach: 'lan',
    version: null,
    direct_capable: false,
    inventory: null,
    loggedIn: false,
    ...overrides,
  };
}

function render(mode: AuthModeResponse): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <NodesPage mode={mode} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  resetMeshNodesStateForTest();
  setPendingStorage({
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  clearPendingEnrollments();
});

describe('NodesPage', () => {
  test('standalone（mode:none）整页不渲染', () => {
    expect(render({ ...MODE, mode: 'none' })).toBe('');
  });

  test('mesh 模式渲染节点表：self 在前、指纹 16 位、到达路径与登录按钮', () => {
    setMeshNodesStateForTest({
      entryNodeId: 'entry-1',
      nodes: [
        meshNode({ id: 'remote', name: 'studio', reach: 'relay', online: true, loggedIn: false }),
        meshNode({ id: 'entry-1', name: 'entry', loggedIn: true }),
      ],
    });
    const html = render(MODE);
    expect(html).toContain('data-testid="nodes-table"');
    expect(html).toContain('data-testid="nodes-row-entry-1"');
    expect(html).toContain('data-testid="nodes-row-remote"');
    expect(html.indexOf('nodes-row-entry-1')).toBeLessThan(html.indexOf('nodes-row-remote'));
    // 未登录的远端 node 渲染「登录此节点」按钮
    expect(html).toContain('data-testid="node-login-remote"');
    // 指纹为 sha256(pk) 前 16 hex
    expect(html).toMatch(/<code class="font-mono[^"]*">[0-9a-f]{16}<\/code>/);
    // 账号安全入口
    expect(html).toContain('href="/account/security"');
  });

  test('hub 不可达时给出提示且管理动作禁用', () => {
    setMeshNodesStateForTest({
      entryNodeId: 'entry-1',
      nodes: [meshNode({ id: 'entry-1', name: 'entry', loggedIn: true })],
    });
    const html = render(MODE);
    expect(html).toContain('data-testid="nodes-hub-offline"');
    expect(html).toMatch(/data-testid="nodes-add"[^>]*disabled/);
    expect(html).toMatch(/data-testid="nodes-rename-entry-1"[^>]*disabled/);
    expect(html).toMatch(/data-testid="nodes-revoke-entry-1"[^>]*disabled/);
  });

  test('缺 uid / kdfParams 时不渲染任何管理动作', () => {
    const html = render({ ...MODE, uid: null, kdfParams: null });
    expect(html).not.toContain('data-testid="nodes-table"');
  });
});
