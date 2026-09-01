// 节点管理主体的静态渲染：单张卡片、表格列与合并结果、hub 离线时管理动作禁用。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 nodes-tab 测试同一套做法）。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import type { AuthModeResponse, HubEndpointInfo, MeshNode } from '@tmex/api-client/auth/index';
import type { UpgradeStatus } from '@tmex/shared';
import { encodeBase64url } from '@tmex/shared/auth';
import { installWindowStorage } from '@tmex/stores/test-utils';
import type { NodeActionDeps, NodeUpgradeController, NodeUpgradeEntry } from './types';
import type {
  UpgradeIo,
  UpgradePollOutcome,
  UpgradeStartOutcome,
  UpgradeToasts,
} from './use-node-upgrade';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('@/node/mesh-nodes');
const { resetMeshHubsStateForTest, setMeshHubsStateForTest } = await import('@/node/mesh-hubs');
const { actionErrorText } = await import('./errors');
const { setPendingStorage, clearPendingEnrollments } = await import('@/node/enrollment');
const { NodesManagement, UpgradeAllButton } = await import('./nodes-management');
const { canAutoSignAdmit, invalidCertificateKey, resetEnrollmentEngineForTest } = await import(
  '@/node/enrollment-engine'
);
const { resolveHubPublicUrl } = await import('./enrollment-section');
const { NodesTable } = await import('./nodes-table');
const { IDLE_UPGRADE_ENTRY, IDLE_UPGRADE_BATCH } = await import('./types');
const { classifyPollFailure, isUpgradeBusy, runNodeUpgrade, upgradeErrorText, upgradePhaseText } =
  await import('./use-node-upgrade');
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
  resetMeshHubsStateForTest();
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

  test('「全部升级」紧挨在「添加」左边；latest 未知时禁用', () => {
    setMeshNodesStateForTest({
      entryNodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
      nodes: [meshNode({ id: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e', name: 'entry', loggedIn: true })],
    });
    const html = render(MODE);
    expect(html).toContain('data-testid="nodes-upgrade-all"');
    expect(html.indexOf('data-testid="nodes-refresh"')).toBeLessThan(
      html.indexOf('data-testid="nodes-upgrade-all"')
    );
    expect(html.indexOf('data-testid="nodes-upgrade-all"')).toBeLessThan(
      html.indexOf('data-testid="nodes-add"')
    );
    // 静态渲染跑不了 effect，latest 拿不到：按钮禁用并说明原因
    const tag = buttonTag(html, 'nodes-upgrade-all');
    expect(tag).toContain('disabled=""');
    expect(tag).toContain('title="nodes.upgrade.releaseUnavailable"');
  });
});

describe('Hub 集群展示与 standby 拒写', () => {
  const HUB_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
  const HUB_B = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';
  const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';

  function hubInfo(overrides: Partial<HubEndpointInfo> & { nodeId: string }): HubEndpointInfo {
    return {
      publicUrl: `https://${overrides.nodeId}.example`,
      mode: 'active',
      priority: 0,
      writerEpoch: 1,
      online: true,
      ...overrides,
    };
  }

  function withNodes(extra: MeshNode[] = []): void {
    setMeshNodesStateForTest({
      entryNodeId: ENTRY,
      nodes: [meshNode({ id: ENTRY, name: 'entry', loggedIn: true }), ...extra],
    });
  }

  test('只有一台 hub 时不渲染集群条，也没有备用 hub 提示', () => {
    withNodes();
    setMeshHubsStateForTest({
      hubs: [hubInfo({ nodeId: HUB_A })],
      writerHubId: HUB_A,
      attached: {
        hubNodeId: HUB_A,
        publicUrl: `https://${HUB_A}.example`,
        mode: 'active',
        writerEpoch: 1,
        since: 1,
      },
      loadedAt: 1,
    });
    const html = render(MODE);
    expect(html).not.toContain('data-testid="nodes-hub-strip"');
    expect(html).not.toContain('data-testid="nodes-hub-standby"');
  });

  test('两台 hub：一台一枚 chip，挂载的那枚与 writer 那枚各自标出', () => {
    withNodes();
    setMeshHubsStateForTest({
      hubs: [
        hubInfo({ nodeId: HUB_A, name: 'tokyo' }),
        hubInfo({ nodeId: HUB_B, name: 'osaka', mode: 'standby', priority: 1, writerEpoch: 0 }),
      ],
      writerHubId: HUB_A,
      attached: {
        hubNodeId: HUB_B,
        publicUrl: `https://${HUB_B}.example`,
        mode: 'standby',
        writerEpoch: 0,
        since: 1,
      },
      loadedAt: 1,
    });
    const html = render(MODE);
    expect(html).toContain('data-testid="nodes-hub-strip"');
    const chipA = html.slice(html.indexOf(`data-testid="nodes-hub-chip-${HUB_A}"`));
    expect(chipA.slice(0, 200)).toContain('data-hub-writer="true"');
    expect(chipA.slice(0, 200)).toContain('data-hub-attached="false"');
    const chipB = html.slice(html.indexOf(`data-testid="nodes-hub-chip-${HUB_B}"`));
    expect(chipB.slice(0, 200)).toContain('data-hub-attached="true"');
    expect(chipB.slice(0, 200)).toContain('data-hub-mode="standby"');
    expect(html).toContain('tokyo');
    expect(html).toContain('osaka');
  });

  test('挂在备用 hub 上：给出一行说明并禁用加入 / 重命名 / 移除，升级不受影响', () => {
    withNodes([meshNode({ id: HUB_B, name: 'osaka', isHub: true, hubMode: 'standby' })]);
    setMeshHubsStateForTest({
      hubs: [hubInfo({ nodeId: HUB_A }), hubInfo({ nodeId: HUB_B, mode: 'standby' })],
      writerHubId: HUB_A,
      attached: {
        hubNodeId: HUB_B,
        publicUrl: `https://${HUB_B}.example`,
        mode: 'standby',
        writerEpoch: 0,
        since: 1,
      },
      loadedAt: 1,
    });
    const html = render(MODE);
    expect(html).toContain('data-testid="nodes-hub-standby"');
    // 「hub 不可达」说的是同一件事，不再重复一遍
    expect(html).not.toContain('data-testid="nodes-hub-offline"');
    expect(buttonTag(html, 'nodes-add')).toContain('disabled=""');
    expect(buttonTag(html, 'nodes-add')).toContain('title="nodes.hubs.standbyNotice"');
    expect(buttonTag(html, `nodes-rename-${ENTRY}`)).toContain('title="nodes.hubs.standbyNotice"');
    expect(buttonTag(html, `nodes-revoke-${HUB_B}`)).toContain('disabled=""');
    expect(buttonTag(html, `node-upgrade-${ENTRY}`)).not.toContain('disabled=""');
  });

  test('表内 hub 徽标区分主 / 备；旧后端不下发 hubMode 时仍是「Hub」', () => {
    withNodes([
      meshNode({ id: HUB_A, name: 'tokyo', isHub: true, hubMode: 'active' }),
      meshNode({ id: HUB_B, name: 'osaka', isHub: true, hubMode: 'standby' }),
    ]);
    const html = render(MODE);
    expect(html).toContain(`data-testid="nodes-hub-tag-${HUB_A}" data-hub-mode="active"`);
    expect(html).toContain(`data-testid="nodes-hub-tag-${HUB_B}" data-hub-mode="standby"`);
    expect(html).toContain('nodes.hubs.active');
    expect(html).toContain('nodes.hubs.standby');

    withNodes([meshNode({ id: HUB_A, name: 'tokyo', isHub: true })]);
    const legacy = render(MODE);
    expect(legacy).toContain(`data-testid="nodes-hub-tag-${HUB_A}" data-hub-mode=""`);
    expect(legacy).toContain('nodes.hub');
  });
});

describe('actionErrorText 的 HUB_NOT_WRITER', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${JSON.stringify(options)}` : key;

  test('知道 writer 地址时把地址写进提示', () => {
    const text = actionErrorText(t, { code: 'HUB_NOT_WRITER' }, { writerPublicUrl: 'https://w' });
    expect(text).toBe('nodes.hubs.notWriter:{"url":"https://w"}');
  });

  test('不知道 writer 地址时退回不带地址的那句', () => {
    expect(actionErrorText(t, { code: 'HUB_NOT_WRITER' })).toContain('auth.errors.HUB_NOT_WRITER');
  });

  test('其余带 code 的错误照旧走错误表', () => {
    expect(actionErrorText(t, { code: 'MALFORMED' }, { writerPublicUrl: 'https://w' })).toContain(
      'auth.errors.MALFORMED'
    );
  });
});

describe('节点表的升级按钮（注入升级控制器）', () => {
  function nodeRow(overrides: Partial<NodeRow> & { id: string }): NodeRow {
    return {
      runtimeNodeId: overrides.id,
      name: overrides.id,
      publicKey: '',
      fingerprint: 'ffffffffffffffff',
      online: true,
      reach: 'lan',
      transport: null,
      rttMs: null,
      version: '1.1.9',
      directCapable: false,
      loggedIn: true,
      inventory: null,
      isSelf: false,
      isHub: false,
      lastSeenAt: null,
      status: null,
      certificate: null,
      certSig: null,
      ...overrides,
    };
  }

  function controller(latestVersion: string | null): NodeUpgradeController {
    return {
      latest: latestVersion ? { latestVersion, changelog: null, publishedAt: null } : null,
      entryOf: () => IDLE_UPGRADE_ENTRY,
      start: () => undefined,
      startAll: () => undefined,
      batch: IDLE_UPGRADE_BATCH,
      eligibleCount: () => 0,
      anyRunning: false,
    };
  }

  function renderTable(rows: NodeRow[], latestVersion: string | null): string {
    const deps: NodeActionDeps = {
      hubApi: null,
      hubOnline: true,
      hubWritable: true,
      writerPublicUrl: null,
      hubDetails: new Map(),
      mode: {
        ...MODE,
        uid: 'user-1',
        kdfParams: MODE.kdfParams as NonNullable<typeof MODE.kdfParams>,
      },
      api: {} as NodeActionDeps['api'],
      prompt: { dialog: null } as unknown as NodeActionDeps['prompt'],
      onChanged: () => undefined,
      upgrade: controller(latestVersion),
    };
    return renderToStaticMarkup(
      <MemoryRouter>
        <NodesTable rows={rows} {...deps} />
      </MemoryRouter>
    );
  }

  test('已是最新版本：按钮禁用并说明原因', () => {
    const html = renderTable(
      [nodeRow({ id: 'aa', version: '1.2.0' }), nodeRow({ id: 'bb', version: '1.3.0' })],
      '1.2.0'
    );
    for (const id of ['aa', 'bb']) {
      const tag = buttonTag(html, `node-upgrade-${id}`);
      expect(tag).toContain('disabled=""');
      expect(tag).toContain('title="nodes.upgrade.atLatest"');
    }
  });

  test('latest 未知或版本无法解析时保持可点：后端才是权威', () => {
    const unknownLatest = renderTable([nodeRow({ id: 'aa', version: '1.2.0' })], null);
    expect(buttonTag(unknownLatest, 'node-upgrade-aa')).not.toContain('disabled=""');
    const devVersion = renderTable([nodeRow({ id: 'bb', version: '1.2.0_dev' })], '1.2.0');
    expect(buttonTag(devVersion, 'node-upgrade-bb')).not.toContain('disabled=""');
  });

  test('版本低于远程升级门槛：禁用并提示在该机器上手动升级', () => {
    const html = renderTable([nodeRow({ id: 'cc', version: '1.0.9' })], '1.2.0');
    const tag = buttonTag(html, 'node-upgrade-cc');
    expect(tag).toContain('disabled=""');
    expect(tag).toContain('title="nodes.upgrade.tooOld"');
  });

  test('可升级的节点照常可点', () => {
    const html = renderTable([nodeRow({ id: 'dd', version: '1.1.9' })], '1.2.0');
    expect(buttonTag(html, 'node-upgrade-dd')).not.toContain('disabled=""');
  });

  test('批量升级进行中：整列升级按钮锁住，避免同一节点被点两次', () => {
    const deps: NodeActionDeps = {
      hubApi: null,
      hubOnline: true,
      hubWritable: true,
      writerPublicUrl: null,
      hubDetails: new Map(),
      mode: {
        ...MODE,
        uid: 'user-1',
        kdfParams: MODE.kdfParams as NonNullable<typeof MODE.kdfParams>,
      },
      api: {} as NodeActionDeps['api'],
      prompt: { dialog: null } as unknown as NodeActionDeps['prompt'],
      onChanged: () => undefined,
      upgrade: {
        ...controller('1.2.0'),
        batch: { running: true, total: 3, completed: 1 },
      },
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NodesTable rows={[nodeRow({ id: 'ee', version: '1.1.9' })]} {...deps} />
      </MemoryRouter>
    );
    expect(buttonTag(html, 'node-upgrade-ee')).toContain('disabled=""');
  });

  function renderUpgradeAll(upgrade: NodeUpgradeController, rows: NodeRow[] = []): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <UpgradeAllButton rows={rows} upgrade={upgrade} />
      </MemoryRouter>
    );
  }

  test('有可升级节点时「全部升级」可点', () => {
    const html = renderUpgradeAll({ ...controller('1.2.0'), eligibleCount: () => 2 });
    const tag = buttonTag(html, 'nodes-upgrade-all');
    expect(tag).not.toContain('disabled=""');
    expect(tag).toContain('title="nodes.upgrade.allHint"');
  });

  test('已有行内升级在跑：「全部升级」立刻变灰并说明原因', () => {
    const html = renderUpgradeAll({
      ...controller('1.2.0'),
      eligibleCount: () => 2,
      anyRunning: true,
    });
    const tag = buttonTag(html, 'nodes-upgrade-all');
    expect(tag).toContain('disabled=""');
    expect(tag).toContain('title="nodes.upgrade.allBusy"');
  });

  test('批量进行中：按钮变灰并显示进度，而不是「已有节点在升级」', () => {
    const html = renderUpgradeAll({
      ...controller('1.2.0'),
      eligibleCount: () => 3,
      anyRunning: true,
      batch: { running: true, total: 3, completed: 2 },
    });
    const tag = buttonTag(html, 'nodes-upgrade-all');
    expect(tag).toContain('disabled=""');
    expect(tag).toContain('title="nodes.upgrade.allHint"');
    expect(html).toContain('nodes.upgrade.allProgress');
  });

  test('没有可升级节点：变灰并说明', () => {
    const tag = buttonTag(renderUpgradeAll(controller('1.2.0')), 'nodes-upgrade-all');
    expect(tag).toContain('disabled=""');
    expect(tag).toContain('title="nodes.upgrade.allNone"');
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

describe('节点升级状态机', () => {
  const t = (key: string) => key;
  const ROW = { id: 'n1', name: 'studio' };

  function idle(overrides: Partial<UpgradeStatus> = {}): UpgradeStatus {
    return { state: 'idle', targetVersion: null, error: null, startedAt: null, ...overrides };
  }

  function statusPoll(status: UpgradeStatus): UpgradePollOutcome {
    return { kind: 'status', status };
  }

  interface Recorder {
    toasts: UpgradeToasts;
    log: Array<[keyof UpgradeToasts, string]>;
  }

  function recorder(): Recorder {
    const log: Array<[keyof UpgradeToasts, string]> = [];
    return {
      log,
      toasts: {
        success: (m) => log.push(['success', m]),
        info: (m) => log.push(['info', m]),
        warning: (m) => log.push(['warning', m]),
        error: (m) => log.push(['error', m]),
      },
    };
  }

  interface FakeIo {
    io: UpgradeIo;
    controller: AbortController;
    counts: { polls: number; versions: number; waits: number };
  }

  /** 假 IO：时钟按 wait 的毫秒推进，poll / nodeVersion 按脚本逐次给结果（越界用最后一项）。 */
  function fakeIo(opts: {
    start: UpgradeStartOutcome;
    polls: UpgradePollOutcome[];
    versions?: Array<string | null | undefined>;
    onWait?: (index: number, controller: AbortController) => void;
    onPoll?: (index: number, controller: AbortController) => void;
  }): FakeIo {
    const controller = new AbortController();
    const counts = { polls: 0, versions: 0, waits: 0 };
    let clock = 0;
    const pick = <T,>(list: T[], index: number): T => list[Math.min(index, list.length - 1)] as T;
    const io: UpgradeIo = {
      start: async () => opts.start,
      poll: async () => {
        counts.polls += 1;
        opts.onPoll?.(counts.polls, controller);
        return pick(opts.polls, counts.polls - 1);
      },
      nodeVersion: async () => pick(opts.versions ?? [undefined], counts.versions++),
      wait: async (ms, signal) => {
        counts.waits += 1;
        clock += ms;
        opts.onWait?.(counts.waits, controller);
        return !signal.aborted;
      },
      now: () => clock,
    };
    return { io, controller, counts };
  }

  test('POST 回包丢失（NODE_UNREACHABLE）不算失败：继续轮询，目标版本变化即确认成功', async () => {
    const rec = recorder();
    const patches: Array<Partial<NodeUpgradeEntry>> = [];
    let changed = 0;
    const fake = fakeIo({
      start: { kind: 'unconfirmed' },
      // 掉线两轮（目标在重启），回来后是 idle 且没有 error——只能靠版本判定
      polls: [{ kind: 'unreachable' }, { kind: 'unreachable' }, statusPoll(idle())],
      versions: ['1.2.0'],
    });
    await runNodeUpgrade({
      row: ROW,
      targetVersion: '1.2.0',
      io: fake.io,
      signal: fake.controller.signal,
      t,
      toasts: rec.toasts,
      patch: (entry) => patches.push(entry),
      onChanged: () => {
        changed += 1;
      },
    });
    // 没有失败 toast，按钮也没有被放回可点状态
    expect(rec.log.map(([kind]) => kind)).toEqual(['warning', 'success']);
    expect(rec.log[0]?.[1]).toBe('nodes.upgrade.startUnconfirmed');
    expect(rec.log[1]?.[1]).toBe('nodes.upgrade.done');
    expect(patches.map((entry) => entry.phase)).toEqual([
      'pending',
      'restarting',
      'restarting',
      'restarting',
      'done',
    ]);
    expect(changed).toBe(1);
  });

  test('POST 回包丢失且目标版本没变：宽限期后只报「未确认」，不报失败原因', async () => {
    const rec = recorder();
    const fake = fakeIo({
      start: { kind: 'unconfirmed' },
      polls: [statusPoll(idle())],
      versions: ['1.1.0'],
    });
    await runNodeUpgrade({
      row: ROW,
      targetVersion: '1.2.0',
      io: fake.io,
      signal: fake.controller.signal,
      t,
      toasts: rec.toasts,
      patch: () => undefined,
      onChanged: () => undefined,
    });
    expect(rec.log).toEqual([
      ['warning', 'nodes.upgrade.startUnconfirmed'],
      ['warning', 'nodes.upgrade.timeout'],
    ]);
    // 30s 宽限期：2s 一轮，第 16 轮才越界，绝不空等满六分钟预算
    expect(fake.counts.polls).toBe(16);
  });

  test('轮询期间节点被移除（404）：一轮内收尾并给出失败原因', async () => {
    const rec = recorder();
    const patches: Array<Partial<NodeUpgradeEntry>> = [];
    let changed = 0;
    const fake = fakeIo({
      start: { kind: 'started', status: idle({ state: 'downloading', targetVersion: '1.2.0' }) },
      polls: [{ kind: 'failed', code: 'NOT_FOUND' }],
      // 节点已不在列表：版本无从比对，只能判失败
      versions: [undefined],
    });
    await runNodeUpgrade({
      row: ROW,
      targetVersion: '1.2.0',
      io: fake.io,
      signal: fake.controller.signal,
      t,
      toasts: rec.toasts,
      patch: (entry) => patches.push(entry),
      onChanged: () => {
        changed += 1;
      },
    });
    expect(fake.counts.polls).toBe(1);
    expect(rec.log).toEqual([
      ['success', 'nodes.upgrade.started'],
      ['error', 'nodes.upgrade.failed'],
    ]);
    expect(patches.at(-1)).toEqual({ phase: 'failed', error: 'nodes.upgrade.nodeGone' });
    expect(changed).toBe(0);
  });

  test('轮询中卸载：不再轮询，也不再 toast / 刷新列表', async () => {
    const rec = recorder();
    const patches: Array<Partial<NodeUpgradeEntry>> = [];
    let changed = 0;
    const fake = fakeIo({
      start: { kind: 'started', status: idle({ state: 'downloading', targetVersion: '1.2.0' }) },
      // 第二轮 GET 在途时组件卸载：真实 IO 会抛 AbortError 并映射成 cancelled
      polls: [statusPoll(idle({ state: 'downloading' })), { kind: 'cancelled' }],
      onPoll: (index, controller) => {
        if (index === 2) controller.abort();
      },
    });
    await runNodeUpgrade({
      row: ROW,
      targetVersion: '1.2.0',
      io: fake.io,
      signal: fake.controller.signal,
      t,
      toasts: rec.toasts,
      patch: (entry) => patches.push(entry),
      onChanged: () => {
        changed += 1;
      },
    });
    expect(fake.counts.polls).toBe(2);
    expect(fake.counts.versions).toBe(0);
    expect(changed).toBe(0);
    // 只有启动时那一条 toast，卸载后不再有超时 / 成功 / 失败提示
    expect(rec.log).toEqual([['success', 'nodes.upgrade.started']]);
    expect(patches.some((entry) => entry.phase === 'failed' || entry.phase === 'done')).toBe(false);
  });

  test('等待期间卸载：连下一轮 GET 都不发', async () => {
    const rec = recorder();
    let changed = 0;
    const fake = fakeIo({
      start: { kind: 'started', status: idle({ state: 'downloading', targetVersion: '1.2.0' }) },
      polls: [statusPoll(idle({ state: 'downloading' }))],
      onWait: (index, controller) => {
        if (index === 1) controller.abort();
      },
    });
    await runNodeUpgrade({
      row: ROW,
      targetVersion: '1.2.0',
      io: fake.io,
      signal: fake.controller.signal,
      t,
      toasts: rec.toasts,
      patch: () => undefined,
      onChanged: () => {
        changed += 1;
      },
    });
    expect(fake.counts.polls).toBe(0);
    expect(changed).toBe(0);
    expect(rec.log).toEqual([['success', 'nodes.upgrade.started']]);
  });

  test('轮询拿到 401 但目标版本已更新：判成功，不冤枉一次升完才丢会话的升级', async () => {
    const rec = recorder();
    const fake = fakeIo({
      start: { kind: 'started', status: idle({ state: 'downloading', targetVersion: '1.2.0' }) },
      polls: [{ kind: 'failed', code: 'NODE_LOGIN_REQUIRED' }],
      versions: ['1.2.0'],
    });
    await runNodeUpgrade({
      row: ROW,
      targetVersion: '1.2.0',
      io: fake.io,
      signal: fake.controller.signal,
      t,
      toasts: rec.toasts,
      patch: () => undefined,
      onChanged: () => undefined,
    });
    expect(rec.log.at(-1)).toEqual(['success', 'nodes.upgrade.done']);
  });

  test('POST 的确定性错误照旧立刻失败', async () => {
    const rec = recorder();
    const fake = fakeIo({ start: { kind: 'failed', code: 'UPGRADE_NOT_ALLOWED' }, polls: [] });
    await runNodeUpgrade({
      row: ROW,
      targetVersion: '1.2.0',
      io: fake.io,
      signal: fake.controller.signal,
      t,
      toasts: rec.toasts,
      patch: () => undefined,
      onChanged: () => undefined,
    });
    expect(fake.counts.polls).toBe(0);
    expect(rec.log).toEqual([['error', 'nodes.upgrade.failed']]);
  });
});

describe('classifyPollFailure', () => {
  test('目标重启期间的 5xx 可重试', () => {
    expect(classifyPollFailure(503, 'NODE_UNREACHABLE')).toBe('retry');
    expect(classifyPollFailure(502, 'BAD_GATEWAY')).toBe('retry');
    expect(classifyPollFailure(504, 'TIMEOUT')).toBe('retry');
  });

  test('确定性业务错误立刻收尾：吊销、会话失效、目标不支持升级', () => {
    expect(classifyPollFailure(404, 'NOT_FOUND')).toBe('definitive');
    expect(classifyPollFailure(404, 'UPGRADE_UNSUPPORTED')).toBe('definitive');
    expect(classifyPollFailure(401, 'NODE_LOGIN_REQUIRED')).toBe('definitive');
    expect(classifyPollFailure(403, 'UPGRADE_NOT_ALLOWED')).toBe('definitive');
    expect(classifyPollFailure(400, 'BAD_REQUEST')).toBe('definitive');
    // 业务码明确时不看状态码
    expect(classifyPollFailure(503, 'UPGRADE_UNSUPPORTED')).toBe('definitive');
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
