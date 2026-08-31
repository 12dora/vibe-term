// 节点管理主体的静态渲染：单张卡片、表格列与合并结果、hub 离线时管理动作禁用。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 nodes-tab 测试同一套做法）。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuthModeResponse, MeshNode } from '@tmex/api-client/auth/index';
import { encodeBase64url } from '@tmex/shared/auth';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('@/node/mesh-nodes');
const { setPendingStorage, clearPendingEnrollments } = await import('@/node/enrollment');
const { NodesManagement } = await import('./nodes-management');
const { canAutoSignAdmit, invalidCertificateKey, resetEnrollmentEngineForTest } = await import(
  '@/node/enrollment-engine'
);
const { resolveHubPublicUrl } = await import('./enrollment-section');
const { isUpgradeBusy, upgradeErrorText, upgradePhaseText } = await import('./use-node-upgrade');
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

/**
 * 取出某个 testid 所在 `<button>` 的开标签。
 * 不能用 `data-testid="x"[^>]*disabled` 这类正则：按钮 class 里就有 `disabled:pointer-events-none`，
 * 任何按钮都会「匹配成功」。禁用与否只认 React 渲染出的 `disabled=""` 属性。
 */
function buttonTag(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<button', at);
  return html.slice(open, html.indexOf('>', at) + 1);
}

function render(mode: AuthModeResponse): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <NodesManagement mode={mode} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  resetEnrollmentEngineForTest();
  resetMeshNodesStateForTest();
  setPendingStorage({
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  clearPendingEnrollments();
});

describe('NodesManagement', () => {
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
  });

  test('整块只有一张卡片：刷新与「添加」在卡头，加入码表单默认收起', () => {
    setMeshNodesStateForTest({
      entryNodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
      nodes: [meshNode({ id: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e', name: 'entry', loggedIn: true })],
    });
    const html = render(MODE);
    expect(html.split('data-slot="card"').length - 1).toBe(1);
    expect(html).toContain('data-testid="nodes-management"');
    expect(html).toContain('data-testid="nodes-refresh"');
    expect(html).toContain('data-testid="nodes-add"');
    expect(html).not.toContain('data-testid="nodes-enroll-form"');
    // 页级标题与账号安全入口都已随独立 /nodes 页一起去掉
    expect(html).not.toContain('data-testid="nodes-account-security"');
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

  test('升级按钮不跟 hub 在线绑定：hub 离线时本机与已登录的在线远端仍可升级', () => {
    setMeshNodesStateForTest({
      entryNodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
      nodes: [
        meshNode({ id: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e', name: 'entry', loggedIn: true }),
        meshNode({
          id: '0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d',
          name: 'studio',
          online: true,
          loggedIn: true,
        }),
      ],
    });
    const html = render(MODE);
    // hub 离线（提示已渲染），rename / revoke 被禁用，但升级按钮照常可用
    expect(html).toContain('data-testid="nodes-hub-offline"');
    expect(buttonTag(html, 'nodes-rename-0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d')).toContain(
      'disabled=""'
    );
    expect(buttonTag(html, 'node-upgrade-0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e')).not.toContain(
      'disabled=""'
    );
    expect(buttonTag(html, 'node-upgrade-0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d')).not.toContain(
      'disabled=""'
    );
    // 每行都是静止态
    expect(html).toContain('data-upgrade-phase="idle"');
  });

  test('未登录的远端与离线节点：升级按钮禁用', () => {
    setMeshNodesStateForTest({
      entryNodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
      nodes: [
        meshNode({ id: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e', name: 'entry', loggedIn: true }),
        meshNode({
          id: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c',
          name: 'studio',
          online: true,
          loggedIn: false,
        }),
        meshNode({
          id: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b',
          name: 'laptop',
          online: false,
          loggedIn: true,
        }),
      ],
    });
    const html = render(MODE);
    // 未登录的在线远端：提示先登录
    const notLoggedIn = buttonTag(html, 'node-upgrade-0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c');
    expect(notLoggedIn).toContain('disabled=""');
    expect(notLoggedIn).toContain('title="nodes.upgrade.loginRequired"');
    // 离线节点：无论登录与否都不可升级
    const offline = buttonTag(html, 'node-upgrade-0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
    expect(offline).toContain('disabled=""');
    expect(offline).toContain('title="nodes.upgrade.offline"');
  });

  test('缺 uid / kdfParams 时不渲染任何管理动作', () => {
    const html = render({ ...MODE, uid: null, kdfParams: null });
    expect(html).not.toContain('data-testid="nodes-table"');
    expect(html).not.toContain('data-testid="nodes-add"');
  });
});

describe('节点升级派生逻辑', () => {
  const t = (key: string) => key;

  test('只有进行中的阶段算忙：done / failed 都要能再次点击', () => {
    expect(isUpgradeBusy('idle')).toBe(false);
    expect(isUpgradeBusy('pending')).toBe(true);
    expect(isUpgradeBusy('downloading')).toBe(true);
    expect(isUpgradeBusy('executing')).toBe(true);
    expect(isUpgradeBusy('restarting')).toBe(true);
    expect(isUpgradeBusy('done')).toBe(false);
    expect(isUpgradeBusy('failed')).toBe(false);
  });

  test('阶段文案：pending 与 restarting 都按「重启中」提示，静止阶段没有文案', () => {
    expect(upgradePhaseText(t, 'downloading')).toBe('nodes.upgrade.stateDownloading');
    expect(upgradePhaseText(t, 'executing')).toBe('nodes.upgrade.stateExecuting');
    expect(upgradePhaseText(t, 'pending')).toBe('nodes.upgrade.stateRestarting');
    expect(upgradePhaseText(t, 'restarting')).toBe('nodes.upgrade.stateRestarting');
    expect(upgradePhaseText(t, 'idle')).toBeNull();
    expect(upgradePhaseText(t, 'done')).toBeNull();
    expect(upgradePhaseText(t, 'failed')).toBeNull();
  });

  test('错误码映射到本地文案，未知码原样展示', () => {
    expect(upgradeErrorText(t, 'NODE_LOGIN_REQUIRED')).toBe('nodes.upgrade.loginRequired');
    expect(upgradeErrorText(t, 'NODE_UNREACHABLE')).toBe('nodes.upgrade.unreachable');
    expect(upgradeErrorText(t, 'UPGRADE_NOT_ALLOWED')).toBe('nodes.upgrade.notAllowed');
    expect(upgradeErrorText(t, 'UPGRADE_IN_PROGRESS')).toBe('nodes.upgrade.inProgress');
    expect(upgradeErrorText(t, 'UPGRADE_UNSUPPORTED')).toBe('nodes.upgrade.unsupported');
    expect(upgradeErrorText(t, 'RELEASE_UNAVAILABLE')).toBe('nodes.upgrade.releaseUnavailable');
    // 「已是最新」不是失败，不进错误表；未知码保持可诊断
    expect(upgradeErrorText(t, 'UPGRADE_ALREADY_LATEST')).toBe('UPGRADE_ALREADY_LATEST');
    expect(upgradeErrorText(t, 'BOOM')).toBe('BOOM');
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

describe('invalidCertificateKey', () => {
  test('过期与验签失败分开提示', () => {
    expect(invalidCertificateKey('expired')).toBe('nodes.enrollment.expired');
    expect(invalidCertificateKey('bad_sig')).toBe('nodes.enrollment.badCertSig');
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
