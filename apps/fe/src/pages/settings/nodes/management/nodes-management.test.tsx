// 节点管理主体的静态渲染：单张卡片、表格列与合并结果、hub 离线时管理动作禁用。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 nodes-tab 测试同一套做法）。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import type { AuthModeResponse, HubEndpointInfo, MeshNode } from '@tmex/api-client/auth/index';
import type { UpgradeStatus } from '@tmex/shared';
import { encodeBase64url } from '@tmex/shared/auth';
import { installWindowStorage } from '@tmex/stores/test-utils';
import { Children, type ReactElement, type ReactNode } from 'react';
import type {
  NodeActionDeps,
  NodeSelection,
  NodeUninstallController,
  NodeUpgradeController,
  NodeUpgradeEntry,
} from './types';
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
const {
  BulkActionsMenuList,
  NodesManagement,
  bulkMenuStates,
  bulkUpgradeTargets,
  pruneSelection,
  selectableRows,
  toggleAllSelection,
  toggleSelection,
} = await import('./nodes-management');
const { canAutoSignAdmit, invalidCertificateKey, resetEnrollmentEngineForTest } = await import(
  '@/node/enrollment-engine'
);
const { resolveHubPublicUrl } = await import('./enrollment-section');
const {
  createUninstallIo,
  isUninstalling,
  planUninstall,
  runUninstallBatch,
  uninstallErrorText,
  uninstallSummaryText,
} = await import('./use-node-uninstall');
const { UninstallDialogBody } = await import('./uninstall-dialog');
const { NodesTable } = await import('./nodes-table');
const { IDLE_UPGRADE_ENTRY, IDLE_UPGRADE_BATCH } = await import('./types');
const {
  classifyPollFailure,
  isUpgradeBusy,
  resumeNodeUpgrade,
  runNodeUpgrade,
  upgradeErrorText,
  upgradePhaseText,
} = await import('./use-node-upgrade');
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

/** 任意元素的开标签（勾选框是 span，不能用 `buttonTag`）。 */
function elementTag(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
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

  test('「更多」紧挨在「添加」左边，且没有单独的「全部升级」', () => {
    setMeshNodesStateForTest({
      entryNodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
      nodes: [meshNode({ id: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e', name: 'entry', loggedIn: true })],
    });
    const html = render(MODE);
    expect(html).toContain('data-testid="nodes-bulk-menu"');
    expect(html).not.toContain('data-testid="nodes-upgrade-all"');
    expect(html.indexOf('data-testid="nodes-refresh"')).toBeLessThan(
      html.indexOf('data-testid="nodes-bulk-menu"')
    );
    expect(html.indexOf('data-testid="nodes-bulk-menu"')).toBeLessThan(
      html.indexOf('data-testid="nodes-add"')
    );
  });

  test('每行一个勾选框；入口自身那一行禁用', () => {
    setMeshNodesStateForTest({
      entryNodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
      nodes: [
        meshNode({ id: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e', name: 'entry', loggedIn: true }),
        meshNode({ id: '0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d', name: 'studio', loggedIn: true }),
      ],
    });
    const html = render(MODE);
    expect(elementTag(html, 'nodes-select-0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e')).toContain(
      'aria-disabled="true"'
    );
    expect(elementTag(html, 'nodes-select-0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d')).not.toContain(
      'aria-disabled'
    );
    // 表头只有一个全选 / 全不选按钮
    const header = elementTag(html, 'nodes-select-all');
    expect(header).toContain('data-all-selected="false"');
    expect(header).toContain('aria-label="nodes.selection.selectAll"');
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
      cancel: () => undefined,
      batch: IDLE_UPGRADE_BATCH,
      eligibleCount: () => 0,
      anyRunning: false,
      restoring: false,
      restoringIds: new Set<string>(),
    };
  }

  function selection(overrides: Partial<NodeSelection> = {}): NodeSelection {
    return {
      ids: new Set<string>(),
      selectableCount: 0,
      toggle: () => undefined,
      toggleAll: () => undefined,
      ...overrides,
    };
  }

  function uninstallController(
    overrides: Partial<NodeUninstallController> = {}
  ): NodeUninstallController {
    return {
      plan: null,
      running: false,
      scheduledIds: new Set<string>(),
      clearingIds: new Set<string>(),
      request: () => undefined,
      confirm: () => undefined,
      dismiss: () => undefined,
      clear: () => undefined,
      ...overrides,
    };
  }

  function renderTable(
    rows: NodeRow[],
    latestVersion: string | null,
    overrides: Partial<NodeUpgradeController> = {},
    extra: { selection?: NodeSelection; uninstall?: NodeUninstallController } = {}
  ): string {
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
      upgrade: { ...controller(latestVersion), ...overrides },
    };
    return renderToStaticMarkup(
      <MemoryRouter>
        <NodesTable
          rows={rows}
          selection={extra.selection ?? selection()}
          uninstall={extra.uninstall ?? uninstallController()}
          {...deps}
        />
      </MemoryRouter>
    );
  }

  function entryOf(phase: NodeUpgradeEntry['phase'], cancelling = false): () => NodeUpgradeEntry {
    return () => ({ phase, targetVersion: '1.2.0', error: null, cancelling });
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
    const html = renderTable([nodeRow({ id: 'ee', version: '1.1.9' })], '1.2.0', {
      batch: { running: true, total: 3, completed: 1 },
    });
    expect(buttonTag(html, 'node-upgrade-ee')).toContain('disabled=""');
  });

  test('静止的行没有「停止升级」按钮', () => {
    for (const phase of ['idle', 'done', 'failed'] as const) {
      const html = renderTable([nodeRow({ id: 'ff' })], '1.2.0', { entryOf: entryOf(phase) });
      expect(html).not.toContain('data-testid="node-upgrade-cancel-ff"');
    }
  });

  test('下载阶段可以停止；安装 / 重启阶段按钮在但禁用并说明原因', () => {
    for (const phase of ['pending', 'downloading'] as const) {
      const html = renderTable([nodeRow({ id: 'ff' })], '1.2.0', { entryOf: entryOf(phase) });
      const tag = buttonTag(html, 'node-upgrade-cancel-ff');
      expect(tag).not.toContain('disabled=""');
      expect(tag).toContain('title="nodes.upgrade.cancel"');
    }
    for (const phase of ['executing', 'restarting'] as const) {
      const html = renderTable([nodeRow({ id: 'ff' })], '1.2.0', { entryOf: entryOf(phase) });
      const tag = buttonTag(html, 'node-upgrade-cancel-ff');
      expect(tag).toContain('disabled=""');
      expect(tag).toContain('title="nodes.upgrade.cancelNotAllowed"');
    }
  });

  test('停止请求在途：按钮转圈并锁住，连点不会再发一次', () => {
    const html = renderTable([nodeRow({ id: 'ff' })], '1.2.0', {
      entryOf: entryOf('downloading', true),
    });
    const tag = buttonTag(html, 'node-upgrade-cancel-ff');
    expect(tag).toContain('disabled=""');
    expect(tag).toContain('title="nodes.upgrade.cancelling"');
    expect(html).toContain('animate-spin');
  });

  test('这一行正在回读升级状态：行内「升级」先变灰并说明原因', () => {
    const html = renderTable([nodeRow({ id: 'gg' }), nodeRow({ id: 'hh' })], '1.2.0', {
      restoringIds: new Set(['gg']),
    });
    const restoring = buttonTag(html, 'node-upgrade-gg');
    expect(restoring).toContain('disabled=""');
    expect(restoring).toContain('title="nodes.upgrade.restoring"');
    // 别的行不受影响
    expect(buttonTag(html, 'node-upgrade-hh')).not.toContain('disabled=""');
  });

  test('正在卸载的行：状态列改显「卸载中」，重命名与升级锁住，移除仍可点', () => {
    const html = renderTable(
      [nodeRow({ id: 'uu', version: '1.1.9' })],
      '1.2.0',
      {},
      {
        uninstall: uninstallController({ scheduledIds: new Set(['uu']) }),
      }
    );
    expect(html).toContain('data-testid="nodes-uninstall-state-uu"');
    expect(html).toContain('nodes.uninstall.stateRunning');
    expect(html).not.toContain('data-testid="nodes-status-uu"');
    expect(buttonTag(html, 'nodes-rename-uu')).toContain('disabled=""');
    expect(buttonTag(html, 'node-upgrade-uu')).toContain('title="nodes.uninstall.busy"');
    // 卸载受理后证书还挂着：移除按钮必须留着
    expect(buttonTag(html, 'nodes-revoke-uu')).not.toContain('disabled=""');
    // 这一行也不能再被勾选
    expect(elementTag(html, 'nodes-select-uu')).toContain('aria-disabled="true"');
  });

  test('卸载失败的行：显示「卸载失败」并带清除按钮，错误进 title', () => {
    const row = nodeRow({ id: 'vv' });
    row.operation = {
      kind: 'uninstall',
      phase: 'failed',
      startedAt: 1,
      updatedAt: 2,
      error: 'exit 1',
    };
    const html = renderTable([row], '1.2.0');
    expect(html).toContain('nodes.uninstall.stateFailed');
    expect(elementTag(html, 'nodes-uninstall-state-vv')).toContain('title="exit 1"');
    expect(html).toContain('data-testid="nodes-uninstall-clear-vv"');
    // 失败的行可以重新勾选（还能再卸一次）
    expect(elementTag(html, 'nodes-select-vv')).not.toContain('aria-disabled');
  });

  test('表头按钮在全选后翻成「全不选」', () => {
    const selected = renderTable(
      [nodeRow({ id: 'ww' })],
      '1.2.0',
      {},
      {
        selection: selection({ ids: new Set(['ww']), selectableCount: 1 }),
      }
    );
    const header = elementTag(selected, 'nodes-select-all');
    expect(header).toContain('data-all-selected="true"');
    expect(header).toContain('aria-label="nodes.selection.clearAll"');
    expect(elementTag(selected, 'nodes-select-ww')).toContain('data-checked');
  });
});

describe('多选的纯逻辑', () => {
  function row(id: string, overrides: Partial<NodeRow> = {}): NodeRow {
    return {
      id,
      runtimeNodeId: id,
      name: id,
      publicKey: '',
      fingerprint: '',
      online: true,
      reach: 'lan',
      transport: null,
      rttMs: null,
      version: '1.1.13',
      directCapable: false,
      loggedIn: true,
      inventory: null,
      isSelf: false,
      isHub: false,
      lastSeenAt: null,
      status: null,
      certificate: null,
      certSig: null,
      operation: null,
      ...overrides,
    };
  }

  test('入口自身与正在卸载的行不可勾选', () => {
    const rows = [
      row('self', { isSelf: true }),
      row('a'),
      row('b', {
        operation: {
          kind: 'uninstall',
          phase: 'uninstalling',
          startedAt: 1,
          updatedAt: 1,
          error: null,
        },
      }),
      row('c'),
    ];
    expect(selectableRows(rows, new Set()).map((item) => item.id)).toEqual(['a', 'c']);
    // 乐观标记同样算「正在卸载」
    expect(selectableRows(rows, new Set(['c'])).map((item) => item.id)).toEqual(['a']);
  });

  test('toggle 在选中与未选中之间来回', () => {
    const once = toggleSelection(new Set<string>(), 'a');
    expect([...once]).toEqual(['a']);
    expect([...toggleSelection(once, 'a')]).toEqual([]);
  });

  test('表头那一个按钮：没全选就全选，已全选就清空', () => {
    const rows = [row('a'), row('b')];
    const all = toggleAllSelection(new Set(['a']), rows);
    expect([...all].sort()).toEqual(['a', 'b']);
    expect([...toggleAllSelection(all, rows)]).toEqual([]);
  });

  test('行消失后勾选态跟着掉；没变化时返回原引用', () => {
    const ids = new Set(['a', 'gone']);
    expect([...pruneSelection(ids, [row('a')])]).toEqual(['a']);
    const stable = new Set(['a']);
    expect(pruneSelection(stable, [row('a')])).toBe(stable);
  });

  describe('批量升级带上本机', () => {
    const self = row('self', { isSelf: true, version: '1.1.12' });

    test('本机不可勾选，但批量升级会把它追加在最后', () => {
      const targets = bulkUpgradeTargets([row('a')], self, '1.1.13');
      expect(targets.selfIncluded).toBe(true);
      expect(targets.rows.map((item) => item.id)).toEqual(['a', 'self']);
    });

    test('一个都没勾时不追加：菜单仍然停在「须先勾选节点」', () => {
      expect(bulkUpgradeTargets([], self, '1.1.13')).toEqual({ rows: [], selfIncluded: false });
    });

    test('本机自己升不了（离线 / 已是最新 / 版本读不出）时不追加', () => {
      const offline = row('self', { isSelf: true, online: false, version: '1.1.12' });
      expect(bulkUpgradeTargets([row('a')], offline, '1.1.13').selfIncluded).toBe(false);
      expect(bulkUpgradeTargets([row('a')], self, '1.1.12').selfIncluded).toBe(false);
      expect(bulkUpgradeTargets([row('a')], null, '1.1.13').selfIncluded).toBe(false);
      // 版本无法解析的本机进不了批量：标签也不能写「含本机」
      const dev = row('self', { isSelf: true, version: '1.1.12_dev' });
      expect(bulkUpgradeTargets([row('a')], dev, '1.1.13').selfIncluded).toBe(false);
      expect(bulkUpgradeTargets([row('a')], self, null).selfIncluded).toBe(false);
    });
  });
});

describe('「更多」菜单的可点性', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${JSON.stringify(options)}` : key;

  const base = {
    selectedCount: 2,
    eligibleUpgradeCount: 2,
    selfIncluded: false,
    latestKnown: true,
    upgradeBusy: false,
    restoring: false,
    writable: true,
    blockedHint: 'nodes.hubOffline',
    uninstallRunning: false,
    revoking: false,
  };

  test('选中了节点、hub 收写入、没有别的批量在跑：三项都可点', () => {
    const states = bulkMenuStates(base, t);
    expect(states.upgrade.disabled).toBe(false);
    expect(states.revoke.disabled).toBe(false);
    expect(states.uninstall.disabled).toBe(false);
  });

  test('一个都没勾：三项都禁用并说明', () => {
    const states = bulkMenuStates({ ...base, selectedCount: 0 }, t);
    for (const item of [states.upgrade, states.revoke, states.uninstall]) {
      expect(item.disabled).toBe(true);
      expect(item.title).toBe('nodes.selection.none');
    }
  });

  test('hub 不收写入：移除与卸载一并禁用，升级不受影响', () => {
    const states = bulkMenuStates({ ...base, writable: false }, t);
    expect(states.revoke.disabled).toBe(true);
    expect(states.revoke.title).toBe('nodes.hubOffline');
    // 卸载最后要签一次 revoke-node：hub 不收写入时机器删干净了证书还留着
    expect(states.uninstall.disabled).toBe(true);
    expect(states.uninstall.title).toBe('nodes.hubOffline');
    expect(states.upgrade.disabled).toBe(false);
  });

  test('本机跟着一起升级时，可点的「升级」也带一句本机会重启的说明', () => {
    const states = bulkMenuStates({ ...base, selfIncluded: true }, t);
    expect(states.upgrade.disabled).toBe(false);
    expect(states.upgrade.title).toBe('nodes.selection.upgradeSelfNotice');
    expect(bulkMenuStates(base, t).upgrade.title).toBeUndefined();
  });

  test('latest 未知 / 没有可升级的：只有「升级」禁用', () => {
    expect(bulkMenuStates({ ...base, latestKnown: false }, t).upgrade.title).toBe(
      'nodes.upgrade.releaseUnavailable'
    );
    expect(bulkMenuStates({ ...base, eligibleUpgradeCount: 0 }, t).upgrade.title).toBe(
      'nodes.upgrade.allNone'
    );
    expect(bulkMenuStates({ ...base, eligibleUpgradeCount: 0 }, t).uninstall.disabled).toBe(false);
  });

  test('批量 / 卸载 / 移除在跑：三项一并禁用，原因各自不同', () => {
    expect(bulkMenuStates({ ...base, upgradeBusy: true }, t).uninstall.title).toBe(
      'nodes.upgrade.allBusy'
    );
    expect(bulkMenuStates({ ...base, restoring: true }, t).upgrade.title).toBe(
      'nodes.upgrade.restoring'
    );
    expect(bulkMenuStates({ ...base, uninstallRunning: true }, t).revoke.title).toBe(
      'nodes.uninstall.running'
    );
    expect(bulkMenuStates({ ...base, revoking: true }, t).upgrade.title).toBe(
      'nodes.selection.busy'
    );
  });

  // 菜单内容走 portal，SSR 什么都不输出：直接对元素树断言（同 AddDeviceMenuList）。
  test('三个菜单项：升级带选中数量，禁用原因进 title', () => {
    const list = BulkActionsMenuList({
      states: bulkMenuStates({ ...base, selectedCount: 0 }, t),
      labels: { upgrade: '升级（3）', revoke: '移除节点', uninstall: '卸载 tmex' },
      onUpgrade: () => undefined,
      onRevoke: () => undefined,
      onUninstall: () => undefined,
    }) as ReactElement<{ children?: ReactNode }>;
    const items = Children.toArray(list.props.children) as ReactElement<{
      'data-testid'?: string;
      disabled?: boolean;
      title?: string;
      children?: ReactNode;
    }>[];
    expect(items.map((item) => item.props['data-testid'])).toEqual([
      'nodes-bulk-upgrade',
      'nodes-bulk-revoke',
      'nodes-bulk-uninstall',
    ]);
    for (const item of items) {
      expect(item.props.disabled).toBe(true);
      expect(item.props.title).toBe('nodes.selection.none');
    }
    expect(JSON.stringify(items[0].props.children)).toContain('升级（3）');
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
      cancel: async () => ({ kind: 'failed', code: 'UPGRADE_NOT_RUNNING', httpStatus: 409 }),
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

  test('目标回到 idle 且带 UPGRADE_CANCELLED：按「已取消」收尾，绝不报失败', async () => {
    const rec = recorder();
    const patches: Array<Partial<NodeUpgradeEntry>> = [];
    let changed = 0;
    const fake = fakeIo({
      start: { kind: 'started', status: idle({ state: 'downloading', targetVersion: '1.2.0' }) },
      polls: [statusPoll(idle({ error: 'UPGRADE_CANCELLED' }))],
    });
    const outcome = await runNodeUpgrade({
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
    expect(outcome).toBe('cancelled');
    expect(rec.log).toEqual([
      ['success', 'nodes.upgrade.started'],
      ['info', 'nodes.upgrade.cancelled'],
    ]);
    expect(patches.at(-1)).toEqual({ phase: 'idle', targetVersion: null, error: null });
    expect(changed).toBe(1);
  });

  test('刷新后接上在跑的升级：状态先写回表格，再按「已见过非 idle」继续盯到成功', async () => {
    const rec = recorder();
    const patches: Array<Partial<NodeUpgradeEntry>> = [];
    let changed = 0;
    const fake = fakeIo({
      start: { kind: 'cancelled' },
      polls: [statusPoll(idle({ state: 'executing' })), statusPoll(idle())],
      versions: ['1.2.0'],
    });
    const outcome = await resumeNodeUpgrade({
      row: ROW,
      status: idle({ state: 'downloading', targetVersion: '1.2.0' }),
      targetVersion: null,
      io: fake.io,
      signal: fake.controller.signal,
      t,
      toasts: rec.toasts,
      patch: (entry) => patches.push(entry),
      onChanged: () => {
        changed += 1;
      },
    });
    expect(outcome).toBe('done');
    // 没有 POST：恢复不重发升级请求
    expect(patches[0]).toEqual({ phase: 'downloading', targetVersion: '1.2.0', error: null });
    expect(patches.map((entry) => entry.phase)).toEqual([
      'downloading',
      'executing',
      'restarting',
      'done',
    ]);
    expect(rec.log).toEqual([['success', 'nodes.upgrade.done']]);
    expect(changed).toBe(1);
  });

  test('刷新后接上的升级同样吃「已取消」：一条 info，不报失败', async () => {
    const rec = recorder();
    const fake = fakeIo({
      start: { kind: 'cancelled' },
      polls: [statusPoll(idle({ error: 'UPGRADE_CANCELLED' }))],
    });
    const outcome = await resumeNodeUpgrade({
      row: ROW,
      status: idle({ state: 'downloading', targetVersion: '1.2.0' }),
      targetVersion: null,
      io: fake.io,
      signal: fake.controller.signal,
      t,
      toasts: rec.toasts,
      patch: () => undefined,
      onChanged: () => undefined,
    });
    expect(outcome).toBe('cancelled');
    expect(rec.log).toEqual([['info', 'nodes.upgrade.cancelled']]);
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

describe('远程卸载', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${JSON.stringify(options)}` : key;

  function row(id: string, overrides: Partial<NodeRow> = {}): NodeRow {
    return {
      id,
      runtimeNodeId: id,
      name: id,
      publicKey: '',
      fingerprint: '',
      online: true,
      reach: 'lan',
      transport: null,
      rttMs: null,
      version: '1.1.13',
      directCapable: false,
      loggedIn: true,
      inventory: null,
      isSelf: false,
      isHub: false,
      lastSeenAt: null,
      status: null,
      certificate: null,
      certSig: null,
      operation: null,
      ...overrides,
    };
  }

  test('分拣：本机 / 离线 / 未登录 / 版本过旧 / 正在卸载都进跳过清单', () => {
    const plan = planUninstall([
      row('ok'),
      row('self', { isSelf: true }),
      row('off', { online: false }),
      row('anon', { loggedIn: false }),
      row('old', { version: '1.1.12' }),
      row('busy', {
        operation: {
          kind: 'uninstall',
          phase: 'requested',
          startedAt: 1,
          updatedAt: 1,
          error: null,
        },
      }),
    ]);
    expect(plan.targets.map((item) => item.id)).toEqual(['ok']);
    expect(plan.skipped.map((item) => [item.row.id, item.reason])).toEqual([
      ['self', 'self'],
      ['off', 'offline'],
      ['anon', 'loginRequired'],
      ['old', 'tooOld'],
      ['busy', 'uninstalling'],
    ]);
  });

  test('版本无法解析时不拦：由后端裁决', () => {
    expect(planUninstall([row('dev', { version: '1.1.12_dev' })]).targets).toHaveLength(1);
    expect(planUninstall([row('unknown', { version: null })]).targets).toHaveLength(1);
  });

  test('乐观标记与服务端记录都算「正在卸载」；failed 不算', () => {
    expect(isUninstalling(row('a'), new Set(['a']))).toBe(true);
    const failed = row('b', {
      operation: { kind: 'uninstall', phase: 'failed', startedAt: 1, updatedAt: 2, error: 'x' },
    });
    expect(isUninstalling(failed, new Set())).toBe(false);
  });

  test('POST 202 算受理；错误码原样带出；网络异常按不可达', async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    const io = createUninstallIo(async (path, init) => {
      calls.push({ path, method: init?.method });
      if (path.includes('/bad/')) {
        return new Response(JSON.stringify({ code: 'UNINSTALL_NOT_ALLOWED' }), { status: 409 });
      }
      if (path.includes('/boom/')) throw new Error('offline');
      return new Response(JSON.stringify({ state: 'scheduled' }), { status: 202 });
    });
    expect(await io.start('good')).toEqual({ kind: 'scheduled' });
    expect(await io.start('bad')).toEqual({ kind: 'failed', code: 'UNINSTALL_NOT_ALLOWED' });
    expect(await io.start('boom')).toEqual({ kind: 'failed', code: 'NODE_UNREACHABLE' });
    expect(calls[0]).toEqual({ path: '/api/mesh/nodes/good/uninstall', method: 'POST' });
  });

  test('清除失败记录走 DELETE /operation', async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    const io = createUninstallIo(async (path, init) => {
      calls.push({ path, method: init?.method });
      return new Response(null, { status: 204 });
    });
    expect(await io.clearOperation('n1')).toBe(true);
    expect(calls[0]).toEqual({ path: '/api/mesh/nodes/n1/operation', method: 'DELETE' });
  });

  test('逐台：受理后才吊销，POST 失败的那台跳过吊销且不打乐观标记', async () => {
    const started: string[] = [];
    const revoked: string[] = [];
    const scheduled: string[] = [];
    const failures: string[] = [];
    const io = {
      start: async (nodeId: string) => {
        started.push(nodeId);
        return nodeId === 'b'
          ? ({ kind: 'failed', code: 'NODE_UNREACHABLE' } as const)
          : ({ kind: 'scheduled' } as const);
      },
      clearOperation: async () => true,
    };
    const summary = await runUninstallBatch({
      targets: [row('a'), row('b'), row('c')],
      io,
      t,
      onScheduled: (nodeId) => scheduled.push(nodeId),
      onFailed: (name) => failures.push(name),
      canWrite: () => true,
      revoke: async (target) => {
        revoked.push(target.id);
        return target.id !== 'c';
      },
    });
    expect(started).toEqual(['a', 'b', 'c']);
    expect(revoked).toEqual(['a', 'c']);
    expect(scheduled).toEqual(['a', 'c']);
    expect(summary.scheduled).toBe(2);
    expect(summary.revoked).toBe(1);
    // b 是 POST 失败，c 是卸下去了但没能从 mesh 里摘掉——两条原因不同
    expect(summary.failed.map((item) => item.name)).toEqual(['b', 'c']);
    expect(summary.failed[0].message).toBe('nodes.uninstall.errors.unreachable');
    expect(summary.failed[1].message).toBe('nodes.uninstall.revokeFailed');
    // 中途失败当场报一次，不必等整批跑完
    expect(failures).toEqual(['b', 'c']);
  });

  test('hub 中途不再收写入：剩下的一台都不碰，已受理的保留记录', async () => {
    const started: string[] = [];
    let writable = true;
    const summary = await runUninstallBatch({
      targets: [row('a'), row('b'), row('c')],
      io: {
        start: async (nodeId: string) => {
          started.push(nodeId);
          // 第一台卸完 hub 就掉线了
          writable = false;
          return { kind: 'scheduled' } as const;
        },
        clearOperation: async () => true,
      },
      t,
      onScheduled: () => undefined,
      canWrite: () => writable,
      revoke: async () => true,
    });
    expect(started).toEqual(['a']);
    expect(summary.scheduled).toBe(1);
    expect(summary.aborted).toBe(2);
  });

  test('hub 一开始就不收写入：一台都不发 POST', async () => {
    const summary = await runUninstallBatch({
      targets: [row('a')],
      io: { start: async () => ({ kind: 'scheduled' }) as const, clearOperation: async () => true },
      t,
      onScheduled: () => undefined,
      canWrite: () => false,
      revoke: async () => true,
    });
    expect(summary).toEqual({ scheduled: 0, revoked: 0, aborted: 1, failed: [] });
  });

  test('稳定错误码走文案表，未知码原样显示', () => {
    expect(uninstallErrorText(t, 'UNINSTALL_UNSUPPORTED')).toBe(
      'nodes.uninstall.errors.unsupported'
    );
    expect(uninstallErrorText(t, 'WAT')).toBe('WAT');
  });

  test('汇总提示：全成功报成功，有失败带上名字', () => {
    expect(uninstallSummaryText(t, { scheduled: 2, revoked: 2, aborted: 0, failed: [] })).toEqual({
      level: 'success',
      text: 'nodes.uninstall.summary:{"count":2}',
    });
    const failed = uninstallSummaryText(t, {
      scheduled: 1,
      revoked: 1,
      aborted: 0,
      failed: [{ name: 'studio', message: 'x' }],
    });
    expect(failed.level).toBe('error');
    expect(failed.text).toContain('studio');
  });

  test('中途停下时汇总说清楚剩了几台没卸', () => {
    const aborted = uninstallSummaryText(t, {
      scheduled: 1,
      revoked: 1,
      aborted: 2,
      failed: [],
    });
    expect(aborted).toEqual({
      level: 'error',
      text: 'nodes.uninstall.summaryAborted:{"count":1,"remaining":2}',
    });
  });

  test('确认框正文：列出将卸载的名字与跳过的原因', () => {
    const plan = planUninstall([row('keep'), row('self', { isSelf: true })]);
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <UninstallDialogBody plan={plan} />
      </MemoryRouter>
    );
    expect(html).toContain('data-testid="nodes-uninstall-target-keep"');
    expect(html).toContain('data-testid="nodes-uninstall-skip-self"');
    expect(html).toContain('nodes.uninstall.skip.self');
    expect(html).not.toContain('data-testid="nodes-uninstall-none"');
  });

  test('一台都卸不了时正文直接说明', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <UninstallDialogBody plan={planUninstall([row('self', { isSelf: true })])} />
      </MemoryRouter>
    );
    expect(html).toContain('data-testid="nodes-uninstall-none"');
    expect(html).toContain('nodes.uninstall.noTargets');
  });
});
