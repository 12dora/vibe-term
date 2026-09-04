// 本机卡的四段版式：卡头（角色 + 唯一状态徽标 + 菜单）、连接、中继服务、网络，
// 外加直连动作流与域名访问控制器的纯逻辑。
// 无 DOM 测试环境，渲染用 react-dom/server，交互行为直接驱动对应的可订阅控制器。

import { afterEach, describe, expect, test } from 'bun:test';
import { resetMeshHubsStateForTest, setMeshHubsStateForTest } from '@/node/mesh-hubs';
import { resetMeshRelayStateForTest, setMeshRelayStateForTest } from '@/node/mesh-relay';
import { ApiClient, type DomainAccessPolicy } from '@tmex/api-client';
import type { AuthModeResponse, MeshHubEndpoint } from '@tmex/api-client/auth/index';
import { LocalApiError } from '@tmex/api-client/local/local-api';
import type {
  LocalDirectAction,
  LocalDirectResponse,
  LocalDirectStatus,
  LocalRole,
  LocalStatusResponse,
} from '@tmex/api-client/local/types';
import zhCN from '@tmex/shared/i18n/locales/zh_CN.json';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import {
  type DirectApi,
  type DirectMutationCallbacks,
  DirectMutationController,
  describeDirectError,
} from './direct-section';
import {
  type DomainAccessApi,
  DomainAccessController,
  domainAccessApi,
  domainAccessConfirmLines,
} from './domain-access-row';
import { LocalMachineCard } from './local-machine-card';
import { useLocalUplinkController } from './uplink/local-uplink-controller';

const MESH_MODE: AuthModeResponse = {
  mode: 'mesh',
  nodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
  uid: 'user-1',
  username: 'alice',
  kdfParams: { salt: 'AAAAAAAAAAAAAAAAAAAAAA', memory_kib: 65536, iterations: 3, parallelism: 1 },
  passkeysForThisOrigin: false,
  passkeyAvailable: false,
  rootEpoch: 0,
};

function status(direct: Partial<LocalDirectStatus> = {}): LocalStatusResponse {
  return {
    role: 'standalone',
    nodeEnv: 'production',
    hubUrl: null,
    hubPublicUrl: null,
    direct: {
      supported: true,
      installed: false,
      enabled: true,
      capable: false,
      version: null,
      platform: 'darwin-arm64',
      ...direct,
    },
    tls: { mode: 'none', listenerRunning: false, tlsPort: null },
    domainAccess: { allowed: true, viaDomain: false, hosts: [] },
    relay: null,
  };
}

const idleApi: DirectApi = {
  setDirect: () => Promise.reject(new Error('unexpected call')),
};

afterEach(() => {
  resetMeshHubsStateForTest();
  resetMeshRelayStateForTest();
});

/** 上级链路 owner 现在建在 `NodesTab` 里，本机卡只收快照：测试里用同一个 hook 现搭一份。 */
function Harness({
  local,
  mode,
  error,
}: {
  local: LocalStatusResponse | null;
  mode: AuthModeResponse | null;
  error?: string | null;
}) {
  const uplink = useLocalUplinkController({ mode });
  return (
    <LocalMachineCard
      mode={mode}
      status={local}
      loading={false}
      loginRequired={false}
      error={error ?? null}
      api={idleApi}
      uplink={uplink}
      onRefresh={() => undefined}
    />
  );
}

function render(
  local: LocalStatusResponse | null,
  mode: AuthModeResponse | null = null,
  error: string | null = null
): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Harness local={local} mode={mode} error={error} />
    </MemoryRouter>
  );
}

/** 三条「角色还不知道」的分支：加载中、未登录、读取失败。 */
function renderUnknownRole(branch: 'loading' | 'loginRequired' | 'error'): string {
  function Unknown() {
    const uplink = useLocalUplinkController({ mode: MESH_MODE });
    return (
      <LocalMachineCard
        mode={MESH_MODE}
        status={null}
        loading={branch === 'loading'}
        loginRequired={branch === 'loginRequired'}
        error={branch === 'error' ? 'fetch failed' : null}
        api={idleApi}
        uplink={uplink}
        onRefresh={() => undefined}
      />
    );
  }
  return renderToStaticMarkup(
    <MemoryRouter>
      <Unknown />
    </MemoryRouter>
  );
}

/** mesh 角色下的完整状态（hub 地址齐全）。 */
function meshStatus(role: LocalRole): LocalStatusResponse {
  return {
    ...status({ installed: true, capable: true }),
    role,
    hubUrl: role === 'node' ? 'https://hub.example' : null,
    hubPublicUrl: role === 'hub,node' ? 'https://hub.example' : null,
  };
}

/** 中继兼节点：本机跑着中继，`relay` 段齐全。 */
function relayNodeStatus(): LocalStatusResponse {
  return {
    ...meshStatus('relay,node'),
    relay: {
      publicUrl: 'https://relay.example.com',
      hasPassword: true,
      tenantCount: 0,
      nodesOnline: 0,
      currentNodes: 0,
    },
  };
}

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

function tagOf(html: string, testId: string): string {
  const tag = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html);
  if (!tag) throw new Error(`missing element: ${testId}`);
  return tag[0];
}

/** 按钮的原生 `disabled`；class 里的 `disabled:` 变体前缀不算数。 */
function buttonDisabled(html: string, testId: string): boolean {
  return / disabled=""/.test(tagOf(html, testId));
}

/** Switch 渲染成 `<span role="switch">`，禁用与选中都在 aria / data 属性上。 */
function switchState(html: string, testId: string): { disabled: boolean; checked: boolean } {
  const tag = tagOf(html, testId);
  return { disabled: /aria-disabled="true"/.test(tag), checked: /aria-checked="true"/.test(tag) };
}

describe('LocalMachineCard 直连状态渲染', () => {
  /** 单枚状态徽章的档位。 */
  function directState(html: string): string {
    const tag = tagOf(html, 'local-machine-direct-status');
    return /data-direct-state="([a-z-]+)"/.exec(tag)?.[1] ?? '';
  }

  test('平台不支持：只有不支持徽章，按钮与开关都禁用，也不提示去安装', () => {
    const html = render(status({ supported: false, platform: 'linux-riscv64' }));
    expect(directState(html)).toBe('unsupported');
    expect(html).toContain('nodes.machine.directUnsupported');
    expect(buttonDisabled(html, 'local-machine-direct-install')).toBe(true);
    expect(switchState(html, 'local-machine-direct-switch')).toEqual({
      disabled: true,
      checked: false,
    });
    expect(html).not.toContain('data-testid="local-machine-direct-hint"');
  });

  test('支持但未安装：安装按钮可用，开关禁用并挂上说明气泡', () => {
    const html = render(status({ installed: false }));
    expect(directState(html)).toBe('not-installed');
    expect(html).toContain('data-testid="local-machine-direct-install"');
    expect(html).not.toContain('data-testid="local-machine-direct-remove"');
    expect(switchState(html, 'local-machine-direct-switch')).toEqual({
      disabled: true,
      checked: false,
    });
    // 常驻的「请先安装插件」那一行已经换成禁用态的气泡触发器
    expect(html).toContain('data-testid="local-machine-direct-hint"');
    expect(html).not.toContain('nodes.machine.directSwitchHint');
  });

  test('已安装且启用：版本徽章 + 删除按钮 + 打开的开关，没有气泡触发器', () => {
    const html = render(
      status({ installed: true, enabled: true, capable: true, version: '0.4.2' })
    );
    expect(directState(html)).toBe('installed');
    expect(html).toContain('nodes.machine.directInstalledVersion');
    expect(html).toContain('data-testid="local-machine-direct-remove"');
    expect(html).not.toContain('data-testid="local-machine-direct-install"');
    expect(switchState(html, 'local-machine-direct-switch')).toEqual({
      disabled: false,
      checked: true,
    });
    expect(html).not.toContain('data-testid="local-machine-direct-hint"');
  });

  test('已安装但关闭：徽章仍是已安装，开关可用且处于关闭态', () => {
    const html = render(
      status({ installed: true, enabled: false, capable: false, version: '0.4.2' })
    );
    expect(directState(html)).toBe('installed');
    expect(switchState(html, 'local-machine-direct-switch')).toEqual({
      disabled: false,
      checked: false,
    });
  });

  test('没有状态时不渲染任何一段正文', () => {
    const html = render(null);
    expect(html).toContain('data-testid="local-machine-card"');
    expect(html).not.toContain('data-testid="local-machine-network"');
    expect(html).not.toContain('data-testid="local-machine-uplink"');
  });
});

describe('LocalMachineCard 的四段版式', () => {
  test('standalone：卡头只有一枚「独立运行」徽标，没有角色徽标与菜单', () => {
    const html = render(status(), null);
    expect(tagOf(html, 'local-machine-status')).toContain('data-status-state="standalone"');
    expect(html).toContain('nodes.machine.status.standalone');
    expect(html).not.toContain('data-testid="local-machine-role"');
    expect(html).not.toContain('data-testid="local-machine-menu"');
    // 连接段就是四条路径的设置向导
    expect(html).toContain('data-testid="local-machine-uplink"');
    expect(html).toContain('data-testid="hub-setup-wizard"');
    expect(html).toContain('data-testid="local-machine-network"');
    // 两个上级 tab 与「通用设置」标题都没有了
    expect(html).not.toContain('data-testid="local-uplink-tabs"');
    expect(html).not.toContain('nodes.machine.general');
  });

  test('mesh：卡头给角色徽标 + 状态徽标 + 操作菜单', () => {
    const html = render(meshStatus('node'), MESH_MODE);
    expect(html).toContain('data-testid="local-machine-role"');
    expect(html).toContain('nodes.machine.roleNode');
    expect(html).toContain('data-testid="local-machine-menu"');
    expect(tagOf(html, 'local-machine-status')).toContain('data-status-state="hubDisconnected"');
  });

  test('mesh 的 hub 形态：连接段是 Hub 面板，没有中继服务段', () => {
    const html = render(meshStatus('node'), MESH_MODE);
    expect(html).toContain('data-testid="local-uplink-hub-panel"');
    expect(html).toContain('data-testid="nodes-relay-enroll"');
    expect(html).not.toContain('data-testid="local-machine-relay-service"');
    expect(html).not.toContain('data-testid="local-uplink-relay-panel"');
  });

  test('中继模式：连接段换成中继面板，Hub 面板整块不出现', () => {
    setMeshRelayStateForTest({
      mode: 'relay',
      relays: [
        {
          url: 'https://relay.example.com',
          priority: 1,
          online: true,
          attached: true,
          rttMs: 45,
        },
      ],
      loadedAt: 1,
    });
    const html = render(meshStatus('node'), MESH_MODE);
    expect(html).toContain('data-testid="local-uplink-relay-panel"');
    expect(html).toContain('data-testid="nodes-relay-row-relay.example.com"');
    expect(html).not.toContain('data-testid="local-uplink-hub-panel"');
    expect(tagOf(html, 'local-machine-status')).toContain('data-status-state="relayConnected"');
    expect(html).toContain('nodes.machine.status.relayConnectedRtt');
  });

  test('中继兼节点：多出一段「中继服务」，地址可复制、口令状态成徽标', () => {
    const local: LocalStatusResponse = {
      ...meshStatus('relay,node'),
      relay: {
        publicUrl: 'https://relay.example.com',
        hasPassword: true,
        tenantCount: 3,
        nodesOnline: 5,
        currentNodes: 7,
      },
    };
    const html = render(local, MESH_MODE);
    expect(html).toContain('data-testid="local-machine-relay-service"');
    expect(html).toContain('data-testid="local-relay-service-url"');
    expect(html).toContain('relay.admin.password.set');
    // 一行式的「租户 x · 在线 y · 节点 z」已经删掉，指标由中继服务的瓦片负责
    expect(html).not.toContain('nodes.machine.relayServiceCounts');
  });

  test('中继兼节点还没接上自己的中继：给出专用接入入口', () => {
    const local: LocalStatusResponse = {
      ...meshStatus('relay,node'),
      relay: {
        publicUrl: 'https://relay.example.com',
        hasPassword: false,
        tenantCount: 0,
        nodesOnline: 0,
        currentNodes: 0,
      },
    };
    const html = render(local, MESH_MODE);
    expect(html).toContain('data-testid="nodes-relay-self-entry"');
    expect(html).toContain('data-testid="nodes-relay-enroll-self"');
    expect(html).toContain('relay.admin.password.unset');
  });

  test('中继角色但没有公网地址：说未设置并指回角色菜单，不复用 Hub 的说法', () => {
    const local: LocalStatusResponse = {
      ...meshStatus('relay,node'),
      relay: {
        publicUrl: null,
        hasPassword: false,
        tenantCount: 0,
        nodesOnline: 0,
        currentNodes: 0,
      },
    };
    const html = render(local, MESH_MODE);
    expect(html).toContain('data-testid="local-relay-service-unset"');
    expect(html).toContain('nodes.machine.relayServiceAddressUnsetHint');
    expect(zhCN.translation.nodes.machine.relayServiceAddressUnsetHint).toContain('中继兼节点');
  });

  test('中继角色还没接入自己的中继：连接段只有一条陈述加一个 CTA，没有 Hub 的任何说法', () => {
    // 现网复现：后端把这台机器的 `mode` 报成 `hub`（`relays: []`），hub 候选里还有一条
    // `http://127.0.0.1` 的占位——旧版式据此摆出「改为接入中继」和「不再连接 Hub」。
    setMeshRelayStateForTest({ mode: 'hub', relays: [], loadedAt: 1 });
    setMeshHubsStateForTest({
      candidates: [{ publicUrl: 'http://127.0.0.1', lastError: null, lastAttemptAt: null }],
      loadedAt: 1,
    });
    const html = render(relayNodeStatus(), MESH_MODE);

    expect(html).toContain('data-testid="nodes-relay-self-entry"');
    expect(occurrences(html, 'data-testid="nodes-relay-enroll-self"')).toBe(1);
    expect(html).toContain('nodes.machine.relayServiceEnrollHint');
    // 预填的是本机自己那台中继的地址，不是别人的
    expect(html).toContain('data-relay-url="https://relay.example.com"');
    // hub 时代的入口与提示一个都不剩
    expect(html).not.toContain('data-testid="local-uplink-hub-panel"');
    expect(html).not.toContain('data-testid="nodes-relay-enroll"');
    expect(html).not.toContain('data-testid="nodes-relay-entry-hint"');
    expect(html).not.toContain('relay.tenant.actions.migrate');
    expect(html).not.toContain('relay.tenant.dialog.migrateNotice');
    expect(html).not.toContain('data-testid="local-machine-change-hub"');
    expect(html).not.toContain('data-testid="local-machine-hub-disconnected"');
  });

  test('中继角色的状态徽标只说中继，且未接入是灰字不是红字', () => {
    setMeshRelayStateForTest({ mode: 'hub', relays: [], loadedAt: 1 });
    const html = render(relayNodeStatus(), MESH_MODE);
    const tag = tagOf(html, 'local-machine-status');
    expect(tag).toContain('data-status-state="relayDisconnected"');
    // 灰字档（outline）而不是红字档（destructive）：刚建好还没接入是预期状态
    expect(tag).toContain('data-variant="outline"');
    expect(tag).not.toContain('data-variant="destructive"');
    expect(html).toContain('nodes.machine.status.relayDisconnected');
    expect(html).not.toContain('nodes.machine.status.hubDisconnected');
  });

  test('纯中继同样不摆 Hub 的话', () => {
    setMeshRelayStateForTest({ mode: 'hub', relays: [], loadedAt: 1 });
    const html = render({ ...relayNodeStatus(), role: 'relay' }, MESH_MODE);
    expect(tagOf(html, 'local-machine-status')).toContain('data-status-state="relayDisconnected"');
    expect(html).toContain('data-testid="nodes-relay-self-entry"');
    expect(html).not.toContain('data-testid="local-uplink-hub-panel"');
  });

  test('中继角色接上自己的中继之后：换回链路面板，CTA 不再出现', () => {
    setMeshRelayStateForTest({
      mode: 'relay',
      relays: [
        { url: 'https://relay.example.com', priority: 1, online: true, attached: true, rttMs: 30 },
      ],
      loadedAt: 1,
    });
    const html = render(relayNodeStatus(), MESH_MODE);
    expect(html).toContain('data-testid="local-uplink-relay-panel"');
    expect(html).toContain('data-testid="nodes-relay-row-relay.example.com"');
    expect(html).toContain('data-testid="nodes-relay-add"');
    expect(occurrences(html, 'data-testid="nodes-relay-enroll-self"')).toBe(0);
    expect(tagOf(html, 'local-machine-status')).toContain('data-status-state="relayConnected"');
    expect(html).toContain('nodes.machine.status.relayConnectedRtt');
    // 中继服务段照旧
    expect(html).toContain('data-testid="local-machine-relay-service"');
  });

  test('挂着的那条中继离线：不算已连接', () => {
    setMeshRelayStateForTest({
      mode: 'relay',
      relays: [{ url: 'https://relay.example.com', priority: 1, online: false, attached: true }],
      loadedAt: 1,
    });
    const html = render(relayNodeStatus(), MESH_MODE);
    expect(tagOf(html, 'local-machine-status')).toContain('data-status-state="relayDisconnected"');
  });

  test('普通节点即便接在中继上也没有中继服务段', () => {
    setMeshRelayStateForTest({ mode: 'relay', relays: [], loadedAt: 1 });
    expect(render(meshStatus('node'), MESH_MODE)).not.toContain(
      'data-testid="local-machine-relay-service"'
    );
  });
});

describe('LocalMachineCard 的状态徽标', () => {
  function stateOf(html: string): string {
    return /data-status-state="([a-zA-Z]+)"/.exec(tagOf(html, 'local-machine-status'))?.[1] ?? '';
  }

  test('挂上 Hub 就是「已连接 Hub」，没挂上是「未连接 Hub」', () => {
    const hub: MeshHubEndpoint = {
      nodeId: 'h1',
      publicUrl: 'https://h1.example',
      name: 'hub-a',
      mode: 'active',
      priority: 0,
      writerEpoch: 1,
      online: true,
    };
    setMeshHubsStateForTest({
      hubs: [hub],
      attached: {
        hubNodeId: 'h1',
        publicUrl: hub.publicUrl,
        mode: 'active',
        writerEpoch: 1,
        since: 1,
      },
      writerHubId: 'h1',
      loadedAt: 1,
    });
    expect(stateOf(render(meshStatus('node'), MESH_MODE))).toBe('hubConnected');
    resetMeshHubsStateForTest();
    expect(stateOf(render(meshStatus('node'), MESH_MODE))).toBe('hubDisconnected');
  });

  test('中继令牌失效时状态徽标直接说失效', () => {
    setMeshRelayStateForTest({
      mode: 'relay',
      relays: [
        { url: 'https://r.example', priority: 1, online: true, attached: true, kicked: true },
      ],
      loadedAt: 1,
    });
    expect(stateOf(render(meshStatus('node'), MESH_MODE))).toBe('relayKicked');
  });
});

describe('LocalMachineCard 在角色未知时的卡头', () => {
  // mesh 下 `/api/local/status` 还没回来 / 401 / 失败：角色未知，菜单里每一项都算不出目标，
  // `useRoleSwitch` 也会直接返回——摆一个点了没反应的菜单比没有菜单更糟。
  for (const branch of ['loading', 'loginRequired', 'error'] as const) {
    test(`${branch}：只给一枚「状态未知」徽标，没有角色徽标也没有菜单`, () => {
      const html = renderUnknownRole(branch);
      expect(tagOf(html, 'local-machine-status')).toContain('data-status-state="unknown"');
      expect(html).toContain('nodes.machine.status.unknown');
      expect(html).not.toContain('data-testid="local-machine-role"');
      expect(html).not.toContain('data-testid="local-machine-menu"');
      expect(html).not.toContain('nodes.machine.roleStandalone');
    });
  }

  test('状态回来之后角色徽标与菜单才出现', () => {
    const html = render(meshStatus('node'), MESH_MODE);
    expect(html).toContain('data-testid="local-machine-role"');
    expect(html).toContain('data-testid="local-machine-menu"');
    expect(tagOf(html, 'local-machine-status')).not.toContain('data-status-state="unknown"');
  });

  test('纯中继没有网页可操作：即便角色已知也不摆菜单', () => {
    const html = render(meshStatus('relay'), MESH_MODE);
    expect(html).toContain('data-testid="local-machine-role"');
    expect(html).not.toContain('data-testid="local-machine-menu"');
  });
});

describe('LocalMachineCard 的读取失败', () => {
  test('非 401 失败：给出原因与重试，而不是空着一张卡', () => {
    const html = render(null, MESH_MODE, 'fetch failed');
    expect(html).toContain('data-testid="local-machine-error"');
    expect(html).toContain('nodes.machine.loadFailed');
    expect(html).toContain('data-testid="local-machine-retry"');
  });

  test('状态照常拿到时不出错误行', () => {
    expect(render(meshStatus('node'), MESH_MODE)).not.toContain(
      'data-testid="local-machine-error"'
    );
  });
});

class RecordingApi implements DirectApi {
  readonly calls: LocalDirectAction[] = [];
  private resolvers: Array<() => void> = [];

  constructor(
    private readonly outcome: (action: LocalDirectAction) => LocalDirectResponse | Error
  ) {}

  setDirect(action: LocalDirectAction): Promise<LocalDirectResponse> {
    this.calls.push(action);
    const outcome = this.outcome(action);
    if (outcome instanceof Error) return Promise.reject(outcome);
    return new Promise((resolve) => {
      this.resolvers.push(() => resolve(outcome));
    });
  }

  /** 放行所有在途请求，用来观察「等待期间」的锁。 */
  flush(): void {
    const pending = this.resolvers;
    this.resolvers = [];
    for (const resolve of pending) resolve();
  }
}

function result(overrides: Partial<LocalDirectResponse> = {}): LocalDirectResponse {
  return {
    ok: true,
    installed: true,
    enabled: true,
    capable: false,
    restartRequired: true,
    ...overrides,
  };
}

function harness(outcome: (action: LocalDirectAction) => LocalDirectResponse | Error) {
  const api = new RecordingApi(outcome);
  const results: LocalDirectResponse[] = [];
  const errors: unknown[] = [];
  let refreshes = 0;
  const callbacks: DirectMutationCallbacks = {
    onResult: (value) => {
      results.push(value);
    },
    onError: (error) => {
      errors.push(error);
    },
    onRefresh: () => {
      refreshes += 1;
    },
  };
  const controller = new DirectMutationController(api, () => callbacks);
  return { api, controller, results, errors, refreshCount: () => refreshes };
}

describe('DirectMutationController 动作流', () => {
  test('安装成功：调用 install，回传结果并重拉状态', async () => {
    const h = harness(() => result({ installed: true, enabled: true }));
    const run = h.controller.run('install');
    expect(h.controller.snapshot().pending).toBe('install');
    h.api.flush();
    await run;
    expect(h.api.calls).toEqual(['install']);
    expect(h.results).toEqual([result({ installed: true, enabled: true })]);
    expect(h.refreshCount()).toBe(1);
    expect(h.controller.snapshot().pending).toBeNull();
  });

  test('安装期间锁住其它动作', async () => {
    const h = harness(() => result());
    const install = h.controller.run('install');
    await h.controller.run('enable');
    h.controller.requestRemove();
    expect(h.api.calls).toEqual(['install']);
    expect(h.controller.snapshot().confirmingRemove).toBe(false);
    h.api.flush();
    await install;

    const enable = h.controller.run('enable');
    h.api.flush();
    await enable;
    expect(h.api.calls).toEqual(['install', 'enable']);
  });

  test('删除必须先确认', async () => {
    const h = harness(() => result({ installed: false, enabled: false }));
    h.controller.requestRemove();
    expect(h.controller.snapshot().confirmingRemove).toBe(true);
    expect(h.api.calls).toEqual([]);

    // 确认对话框开着时不接受别的动作
    await h.controller.run('disable');
    expect(h.api.calls).toEqual([]);

    const confirmed = h.controller.confirmRemove();
    expect(h.controller.snapshot().confirmingRemove).toBe(false);
    h.api.flush();
    await confirmed;
    expect(h.api.calls).toEqual(['remove']);
    expect(h.results[0]?.installed).toBe(false);
    expect(h.results[0]?.enabled).toBe(false);
  });

  test('取消确认不发请求', async () => {
    const h = harness(() => result());
    h.controller.requestRemove();
    h.controller.cancelRemove();
    expect(h.controller.snapshot().confirmingRemove).toBe(false);
    await h.controller.confirmRemove();
    expect(h.api.calls).toEqual([]);
    expect(h.refreshCount()).toBe(0);
  });

  test('开关走 enable / disable', async () => {
    const h = harness(() => result());
    let run = h.controller.run('enable');
    h.api.flush();
    await run;
    run = h.controller.run('disable');
    h.api.flush();
    await run;
    expect(h.api.calls).toEqual(['enable', 'disable']);
    expect(h.refreshCount()).toBe(2);
  });

  test('下载失败：回传错误，仍然重拉状态并解锁', async () => {
    const failure = new LocalApiError('direct_download_failed', 'HTTP 502 from github', 502);
    const h = harness(() => failure);
    await h.controller.run('install');
    expect(h.errors).toEqual([failure]);
    expect(h.results).toEqual([]);
    expect(h.refreshCount()).toBe(1);
    expect(h.controller.snapshot().pending).toBeNull();
  });

  test('订阅者在状态变化时收到通知', async () => {
    const h = harness(() => result());
    let notified = 0;
    const unsubscribe = h.controller.subscribe(() => {
      notified += 1;
    });
    const run = h.controller.run('install');
    h.api.flush();
    await run;
    unsubscribe();
    // pending 置位 + 清空
    expect(notified).toBe(2);
    h.controller.requestRemove();
    expect(notified).toBe(2);
  });
});

describe('describeDirectError', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    options ? `${key}(${JSON.stringify(options)})` : key;

  test('下载失败带上服务端原因', () => {
    const message = describeDirectError(
      t,
      new LocalApiError('direct_download_failed', 'HTTP 502 from github', 502)
    );
    expect(message).toBe(
      'nodes.machine.directErrorDetail({"base":"nodes.machine.directErrorDownloadFailed","detail":"HTTP 502 from github"})'
    );
  });

  test('message 就是错误码时不重复展示', () => {
    expect(
      describeDirectError(t, new LocalApiError('direct_unsupported', 'direct_unsupported', 409))
    ).toBe('nodes.machine.directErrorUnsupported');
  });

  test('未安装就开启：给出安装提示', () => {
    expect(
      describeDirectError(t, new LocalApiError('direct_not_installed', 'direct_not_installed', 409))
    ).toBe('nodes.machine.directErrorNotInstalled');
  });

  test('未知错误退化到通用文案 + 原始信息', () => {
    expect(describeDirectError(t, new Error('boom'))).toBe(
      'nodes.machine.directErrorDetail({"base":"nodes.machine.directFailed","detail":"boom"})'
    );
  });
});

describe('删除直连插件的后果按上级形态分档', () => {
  test('hub 与中继各有一句，不再对中继节点说「经 Hub 中转」', () => {
    expect(zhCN.translation.nodes.machine.directRemoveConfirm.description).toContain('Hub');
    expect(zhCN.translation.nodes.machine.directRemoveConfirm.descriptionRelay).toContain('中继');
    expect(zhCN.translation.nodes.machine.directRemoveConfirm.descriptionRelay).not.toContain(
      'Hub'
    );
  });
});

describe('LocalMachineCard 的允许域名访问', () => {
  const ROW = 'data-testid="local-machine-domain-access-switch"';

  function withDomainAccess(policy: DomainAccessPolicy | undefined): LocalStatusResponse {
    const base = meshStatus('hub,node');
    if (policy) return { ...base, domainAccess: policy };
    // 旧节点根本不下发该字段
    const { domainAccess: _omitted, ...rest } = base;
    return rest as LocalStatusResponse;
  }

  test('旧节点不下发该字段时整行不渲染，但「网络」段还在', () => {
    const html = render(withDomainAccess(undefined), MESH_MODE);
    expect(html).not.toContain(ROW);
    expect(html).toContain('data-testid="local-machine-network"');
  });

  test('有公开域名：开关与标签同一行，说明另起一行，不再单起「通用设置」标题', () => {
    const html = render(
      withDomainAccess({ allowed: true, viaDomain: false, hosts: ['tmex.example.com'] }),
      MESH_MODE
    );
    expect(html).toContain('nodes.machine.domainAccess.label');
    expect(html).toContain('nodes.machine.domainAccess.description');
    expect(html).not.toContain('data-testid="local-machine-general-heading"');
    expect(switchState(html, 'local-machine-domain-access-switch')).toEqual({
      disabled: false,
      checked: true,
    });
    // 开关在标签行内（与直连插件同一套版式），说明落在该行之后
    const label = html.indexOf('nodes.machine.domainAccess.label');
    const toggle = html.indexOf('data-testid="local-machine-domain-access-switch"');
    const hint = html.indexOf('data-testid="local-machine-domain-access-hint"');
    expect(label).toBeLessThan(toggle);
    expect(toggle).toBeLessThan(hint);
  });

  test('说明只有一句，不再是带括号的长句', () => {
    const zh = zhCN.translation.nodes.machine.domainAccess.description;
    expect(zh).toBe(
      '关闭后拒绝来自公网的网页与 API 访问，局域网、本机与节点互联不受影响。公开域名：{{hosts}}'
    );
    expect(zh).not.toContain('（');
    expect(zh).not.toContain('(');
  });

  test('没有公开域名：说清尚未配置并禁用开关', () => {
    const html = render(
      withDomainAccess({ allowed: true, viaDomain: false, hosts: [] }),
      MESH_MODE
    );
    expect(html).toContain('nodes.machine.domainAccess.noHosts');
    expect(switchState(html, 'local-machine-domain-access-switch').disabled).toBe(true);
  });

  test('已关闭时开关处于关闭态', () => {
    const html = render(
      withDomainAccess({ allowed: false, viaDomain: false, hosts: ['tmex.example.com'] }),
      MESH_MODE
    );
    expect(switchState(html, 'local-machine-domain-access-switch').checked).toBe(false);
  });

  test('正经该域名访问时确认框多一条强提示', () => {
    expect(domainAccessConfirmLines(false)).toEqual([
      'nodes.machine.domainAccess.confirm.description',
    ]);
    expect(domainAccessConfirmLines(true)).toEqual([
      'nodes.machine.domainAccess.confirm.description',
      'nodes.machine.domainAccess.confirm.viaDomain',
    ]);
  });
});

describe('DomainAccessController', () => {
  function harnessDomain(outcome: (allowed: boolean) => DomainAccessPolicy | Error) {
    const calls: boolean[] = [];
    const results: DomainAccessPolicy[] = [];
    let refreshes = 0;
    const api: DomainAccessApi = {
      update: (allowed) => {
        calls.push(allowed);
        const value = outcome(allowed);
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      },
    };
    const controller = new DomainAccessController(api, () => ({
      onResult: (policy) => {
        results.push(policy);
      },
      onRefresh: () => {
        refreshes += 1;
      },
    }));
    return { calls, results, controller, refreshCount: () => refreshes };
  }

  const policy = (allowed: boolean): DomainAccessPolicy => ({
    allowed,
    viaDomain: false,
    hosts: ['tmex.example.com'],
  });

  test('开启不需要确认，直接写', async () => {
    const h = harnessDomain(() => policy(true));
    await h.controller.request(true);
    expect(h.calls).toEqual([true]);
    expect(h.results).toEqual([policy(true)]);
    expect(h.refreshCount()).toBe(1);
    expect(h.controller.snapshot().confirming).toBe(false);
  });

  test('关闭先确认：确认前不发请求', async () => {
    const h = harnessDomain(() => policy(false));
    await h.controller.request(false);
    expect(h.controller.snapshot().confirming).toBe(true);
    expect(h.calls).toEqual([]);

    await h.controller.confirm();
    expect(h.calls).toEqual([false]);
    expect(h.controller.snapshot().confirming).toBe(false);
    expect(h.refreshCount()).toBe(1);
  });

  test('取消确认不发请求', async () => {
    const h = harnessDomain(() => policy(false));
    await h.controller.request(false);
    h.controller.cancel();
    await h.controller.confirm();
    expect(h.calls).toEqual([]);
    expect(h.refreshCount()).toBe(0);
  });

  test('失败时留下错误，不刷新状态', async () => {
    const failure = new Error('domain_access_update_failed');
    const h = harnessDomain(() => failure);
    await h.controller.request(true);
    expect(h.controller.snapshot().error).toBe(failure);
    expect(h.controller.snapshot().pending).toBe(false);
    expect(h.refreshCount()).toBe(0);
  });
});

describe('updateDomainAccess 请求体', () => {
  test('PATCH /api/system/domain-access，body 带 allowed', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const client = new ApiClient('', (url, init) => {
      seen.push({ url, ...(init ? { init } : {}) });
      return Promise.resolve(
        new Response(JSON.stringify({ allowed: false, viaDomain: true, hosts: ['a.example'] }), {
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });
    const policy = await domainAccessApi(client).update(false);
    expect(seen[0]?.url).toBe('/api/system/domain-access');
    expect(seen[0]?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ allowed: false });
    expect(policy).toEqual({ allowed: false, viaDomain: true, hosts: ['a.example'] });
  });
});
