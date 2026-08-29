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
const { canAutoSignAdmit } = await import('./nodes/use-admit-action');
const { resolveHubPublicUrl } = await import('./nodes/enrollment-section');
const { rootKeyFromSeed } = await import('@tmex/shared/auth');

const MODE: AuthModeResponse = {
  mode: 'mesh',
  nodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
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
      entryNodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
      nodes: [
        meshNode({
          id: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c',
          name: 'studio',
          reach: 'relay',
          online: true,
          loggedIn: false,
        }),
        meshNode({ id: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e', name: 'entry', loggedIn: true }),
      ],
    });
    const html = render(MODE);
    expect(html).toContain('data-testid="nodes-table"');
    expect(html).toContain('data-testid="nodes-row-0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e"');
    expect(html).toContain('data-testid="nodes-row-0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"');
    expect(html.indexOf('nodes-row-0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e')).toBeLessThan(
      html.indexOf('nodes-row-0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c')
    );
    // 未登录的远端 node 渲染「登录此节点」按钮
    expect(html).toContain('data-testid="node-login-0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"');
    // 指纹为 sha256(pk) 前 16 hex
    expect(html).toMatch(/<code class="font-mono[^"]*">[0-9a-f]{16}<\/code>/);
    // 账号安全入口
    expect(html).toContain('href="/account/security"');
  });

  test('hub 不可达时给出提示且管理动作禁用', () => {
    setMeshNodesStateForTest({
      entryNodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
      nodes: [meshNode({ id: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e', name: 'entry', loggedIn: true })],
    });
    const html = render(MODE);
    expect(html).toContain('data-testid="nodes-hub-offline"');
    expect(html).toMatch(/data-testid="nodes-add"[^>]*disabled/);
    expect(html).toMatch(
      /data-testid="nodes-rename-0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e"[^>]*disabled/
    );
    expect(html).toMatch(
      /data-testid="nodes-revoke-0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e"[^>]*disabled/
    );
  });

  test('缺 uid / kdfParams 时不渲染任何管理动作', () => {
    const html = render({ ...MODE, uid: null, kdfParams: null });
    expect(html).not.toContain('data-testid="nodes-table"');
  });
});

describe('canAutoSignAdmit', () => {
  test('根钥可以后台自动签 admit-node', () => {
    expect(
      canAutoSignAdmit({ kind: 'root', rootKey: rootKeyFromSeed(new Uint8Array(32).fill(1)) })
    ).toBe(true);
  });

  test('passkey 不行：认证器仪式必须由用户手势触发，留在「待确认」', () => {
    expect(canAutoSignAdmit({ kind: 'passkey', credentialId: 'a' })).toBe(false);
    expect(canAutoSignAdmit(null)).toBe(false);
  });
});

describe('resolveHubPublicUrl', () => {
  test('优先用 enrollment 创建响应里的 public_url', () => {
    expect(
      resolveHubPublicUrl(
        { hubPublicUrl: 'https://hub.example' },
        {
          hubPublicUrl: 'https://mode.example',
        }
      )
    ).toBe('https://hub.example');
  });

  test('创建响应没给时退到 /api/auth/mode 的 hubPublicUrl', () => {
    expect(
      resolveHubPublicUrl({ hubPublicUrl: null }, { hubPublicUrl: 'https://mode.example' })
    ).toBe('https://mode.example');
    expect(resolveHubPublicUrl(null, { hubPublicUrl: 'https://mode.example' })).toBe(
      'https://mode.example'
    );
  });

  test('两处都没有时返回 null——绝不退化成入口 origin', () => {
    expect(resolveHubPublicUrl(null, {})).toBeNull();
    expect(resolveHubPublicUrl({ hubPublicUrl: null }, { hubPublicUrl: null })).toBeNull();
  });
});
