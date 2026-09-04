// 本机区块的直连插件区：四种状态的静态渲染，加上安装 / 删除 / 启停的动作流。
// 无 DOM 测试环境，渲染用 react-dom/server，交互行为直接驱动 `DirectMutationController`
// （它就是为了脱离 DOM 可测才被拆成可订阅控制器的）。

import { afterEach, describe, expect, test } from 'bun:test';
import { resetMeshHubsStateForTest, setMeshHubsStateForTest } from '@/node/mesh-hubs';
import { resetMeshRelayStateForTest } from '@/node/mesh-relay';
import { ApiClient, type DomainAccessPolicy } from '@tmex/api-client';
import type {
  AuthModeResponse,
  MeshAttachedHub,
  MeshHubEndpoint,
} from '@tmex/api-client/auth/index';
import { LocalApiError } from '@tmex/api-client/local/local-api';
import type {
  LocalDirectAction,
  LocalDirectResponse,
  LocalDirectStatus,
  LocalRole,
  LocalStatusResponse,
} from '@tmex/api-client/local/types';
import enUS from '@tmex/shared/i18n/locales/en_US.json';
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
import { LocalMachineCard, SELECTABLE_ROLES } from './local-machine-card';
import { ROLE_LABEL_KEY } from './membership/role-transition';
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
}: {
  local: LocalStatusResponse | null;
  mode: AuthModeResponse | null;
}) {
  const uplink = useLocalUplinkController({ mode });
  return (
    <LocalMachineCard
      mode={mode}
      status={local}
      loading={false}
      loginRequired={false}
      api={idleApi}
      uplink={uplink}
      onRefresh={() => undefined}
    />
  );
}

function render(local: LocalStatusResponse | null, mode: AuthModeResponse | null = null): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Harness local={local} mode={mode} />
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

  test('平台不支持：只有不支持徽章，按钮与开关都禁用', () => {
    const html = render(status({ supported: false, platform: 'linux-riscv64' }));
    expect(directState(html)).toBe('unsupported');
    expect(html).toContain('nodes.machine.directUnsupported');
    expect(buttonDisabled(html, 'local-machine-direct-install')).toBe(true);
    expect(switchState(html, 'local-machine-direct-switch')).toEqual({
      disabled: true,
      checked: false,
    });
    // 不支持时装不上，别再提示「先去安装」
    expect(html).not.toContain('data-testid="local-machine-direct-hint"');
  });

  test('支持但未安装：安装按钮可用，开关禁用并给出提示', () => {
    const html = render(status({ installed: false }));
    expect(directState(html)).toBe('not-installed');
    expect(html).toContain('nodes.machine.directNotInstalled');
    expect(html).toContain('data-testid="local-machine-direct-install"');
    expect(html).not.toContain('data-testid="local-machine-direct-remove"');
    expect(buttonDisabled(html, 'local-machine-direct-install')).toBe(false);
    expect(switchState(html, 'local-machine-direct-switch')).toEqual({
      disabled: true,
      checked: false,
    });
    expect(html).toContain('data-testid="local-machine-direct-hint"');
  });

  test('已安装且启用：版本徽章 + 删除按钮 + 打开的开关，不再另起一行开关', () => {
    const html = render(
      status({ installed: true, enabled: true, capable: true, version: '0.4.2' })
    );
    expect(directState(html)).toBe('installed');
    expect(html).toContain('nodes.machine.directInstalledVersion');
    expect(html).toContain('nodes.machine.directEnable');
    expect(html).toContain('data-testid="local-machine-direct-remove"');
    expect(html).not.toContain('data-testid="local-machine-direct-install"');
    expect(buttonDisabled(html, 'local-machine-direct-remove')).toBe(false);
    expect(switchState(html, 'local-machine-direct-switch')).toEqual({
      disabled: false,
      checked: true,
    });
    expect(html).not.toContain('data-testid="local-machine-direct-hint"');
    // 「本平台支持 / 已启用 / 已关闭」三枚徽章已并进这一枚 + 开关
    expect(html).not.toContain('nodes.machine.directSupported');
    expect(html).not.toContain('nodes.machine.directActive');
    expect(html).not.toContain('nodes.machine.directDisabled');
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

  test('未安装时没有版本文案，安装后徽章跟着版本走', () => {
    expect(render(status({ installed: false, version: null }))).not.toContain(
      'nodes.machine.directInstalledVersion'
    );
    expect(render(status({ installed: true, version: null }))).toContain(
      '>nodes.machine.directInstalled<'
    );
  });

  test('没有状态时不渲染直连区', () => {
    const html = render(null);
    expect(html).toContain('data-testid="local-machine-card"');
    expect(html).not.toContain('data-testid="local-machine-direct-switch"');
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

describe('LocalMachineCard 角色与 Hub 归属', () => {
  test('角色渲染成下拉而不是只读徽章，值就是当前角色', () => {
    const html = render(meshStatus('node'), MESH_MODE);
    const tag = tagOf(html, 'local-machine-role');
    expect(tag).toContain('data-slot="select-trigger"');
    expect(html).toContain('nodes.machine.roleNode');
    // 隐藏的原生 input 带着当前值，提交/回填都以它为准
    expect(html).toContain('value="node"');
  });

  test('角色下拉给全五个角色，纯中继写明没有网页', () => {
    // Select 的选项只在展开时才渲染，静态版式里看不到：直接断言候选列表与文案。
    expect(SELECTABLE_ROLES).toEqual(['standalone', 'node', 'hub,node', 'relay,node', 'relay']);
    for (const role of SELECTABLE_ROLES) expect(ROLE_LABEL_KEY[role]).toBeString();
    expect(zhCN.translation.nodes.machine.roleRelay).toContain('无网页');
    expect(zhCN.translation.nodes.machine.roleRelayNode).toBe('中继兼节点');
  });

  test('中继兼节点：角色下拉照样显示当前角色', () => {
    const html = render(meshStatus('relay,node'), MESH_MODE);
    expect(html).toContain('value="relay,node"');
    expect(html).toContain('nodes.machine.roleRelayNode');
  });

  test('纯 node：「当前 Hub」这一行带上「更换 Hub」，不再另起一行加入地址', () => {
    const html = render(meshStatus('node'), MESH_MODE);
    expect(html).toContain('nodes.machine.currentHub');
    expect(html).toContain('data-testid="local-machine-change-hub"');
    expect(html).toContain('nodes.membership.changeHub');
    expect(buttonDisabled(html, 'local-machine-change-hub')).toBe(false);
    expect(html).not.toContain('nodes.machine.hubUrl');
    expect(html).not.toContain('nodes.machine.localAddress');
  });

  test('hub 兼节点：本机地址只读，没有换 hub 入口', () => {
    const html = render(meshStatus('hub,node'), MESH_MODE);
    expect(html).toContain('nodes.machine.localAddress');
    expect(html).toContain('data-testid="local-machine-local-address"');
    expect(html).not.toContain('data-testid="local-machine-change-hub"');
    // 角色下拉照样可用
    expect(html).toContain('data-testid="local-machine-role"');
  });

  test('hub 兼节点但没有公开地址：说未设置并指回角色设置', () => {
    const html = render({ ...meshStatus('hub,node'), hubPublicUrl: null }, MESH_MODE);
    expect(html).toContain('data-testid="local-machine-local-address-unset"');
    expect(html).toContain('nodes.machine.localAddressHint');
    expect(html).not.toContain('data-testid="local-machine-local-address"');
  });

  test('standalone：没有地址行，也没有换 hub 入口', () => {
    const html = render(status(), null);
    expect(html).not.toContain('nodes.machine.localAddress');
    expect(html).not.toContain('nodes.machine.currentHub');
    expect(html).not.toContain('data-testid="local-machine-change-hub"');
    expect(html).toContain('nodes.machine.roleStandalone');
  });

  test('mesh 下只留账号安全入口，指向右侧面板而不是已删除的整页', () => {
    const html = render(meshStatus('node'), MESH_MODE);
    expect(html).toContain('data-testid="local-machine-account-security"');
    expect(html).toContain('href="/?panel=security"');
    expect(html).not.toContain('href="/account/security"');
    expect(html).not.toContain('href="/nodes"');
    expect(html).not.toContain('nodes.machine.openNodesPage');
  });

  test('没有确认请求时不渲染退出对话框', () => {
    expect(render(meshStatus('node'), MESH_MODE)).not.toContain(
      'data-testid="membership-leave-dialog"'
    );
  });
});

describe('LocalMachineCard 的本机 Hub 主 / 备身份', () => {
  const HUB_MODE_ROW = 'data-testid="local-machine-hub-mode"';

  test('hub 集合里认得出本机时显示主 / 备', () => {
    setMeshHubsStateForTest({
      hubs: [
        {
          nodeId: MESH_MODE.nodeId,
          publicUrl: 'https://hub.example',
          mode: 'standby',
          priority: 1,
          writerEpoch: 0,
        },
      ],
      loadedAt: 1,
    });
    const html = render(meshStatus('hub,node'), MESH_MODE);
    expect(html).toContain(HUB_MODE_ROW);
    expect(html).toContain('nodes.hubs.standby');
  });

  test('集合里没有本机、或本机不是 hub 时整行不渲染', () => {
    setMeshHubsStateForTest({
      hubs: [
        {
          nodeId: '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f',
          publicUrl: 'https://other.example',
          mode: 'active',
          priority: 0,
          writerEpoch: 1,
        },
      ],
      loadedAt: 1,
    });
    expect(render(meshStatus('hub,node'), MESH_MODE)).not.toContain(HUB_MODE_ROW);
    resetMeshHubsStateForTest();
    expect(render(meshStatus('node'), MESH_MODE)).not.toContain(HUB_MODE_ROW);
  });
});

describe('LocalMachineCard 的多 hub 归属', () => {
  const ATTACHED_ROW = 'data-testid="local-machine-attached-hub"';
  const HUB_LIST_ROW = 'data-testid="local-machine-hub-list"';
  const WRITER_SUFFIX = 'data-testid="local-machine-writer-hub"';
  const JOIN_SEED_ROW = 'data-testid="local-machine-join-seed"';

  function hubRow(overrides: Partial<MeshHubEndpoint> & { nodeId: string }): MeshHubEndpoint {
    return {
      publicUrl: `https://${overrides.nodeId}.example`,
      mode: 'active',
      priority: 0,
      writerEpoch: 1,
      ...overrides,
    };
  }

  function attachedTo(hub: MeshHubEndpoint): MeshAttachedHub {
    return {
      hubNodeId: hub.nodeId,
      publicUrl: hub.publicUrl,
      mode: hub.mode,
      writerEpoch: hub.writerEpoch,
      since: 1,
    };
  }

  test('挂在 writer 上：名字 + 主 Hub 徽标 + 可复制地址，不补写者', () => {
    const hub = hubRow({ nodeId: 'h1', name: 'hub-a', writerEpoch: 2 });
    setMeshHubsStateForTest({
      hubs: [hub],
      attached: attachedTo(hub),
      writerHubId: 'h1',
      loadedAt: 1,
    });
    const html = render(meshStatus('node'), MESH_MODE);
    expect(html).toContain(ATTACHED_ROW);
    expect(html).toContain('nodes.machine.currentHub');
    expect(html).toContain('>hub-a<');
    expect(tagOf(html, 'local-machine-attached-hub-mode')).toContain('data-hub-mode="active"');
    expect(html).toContain('nodes.hubs.active');
    expect(html).toContain('>https://h1.example<');
    expect(html).not.toContain(WRITER_SUFFIX);
    // 只有一台 hub 时不摆列表：单 hub 用户的版式与之前一致
    expect(html).not.toContain(HUB_LIST_ROW);
  });

  test('挂在备 Hub 上：同一行补出当前写者', () => {
    const writer = hubRow({ nodeId: 'h1', name: 'hub-a', writerEpoch: 3 });
    const standby = hubRow({ nodeId: 'h2', name: 'hub-b', mode: 'standby', priority: 1 });
    setMeshHubsStateForTest({
      hubs: [writer, standby],
      attached: attachedTo(standby),
      writerHubId: 'h1',
      loadedAt: 1,
    });
    const html = render(meshStatus('node'), MESH_MODE);
    expect(html).toContain(ATTACHED_ROW);
    expect(html).toContain('>hub-b<');
    expect(tagOf(html, 'local-machine-attached-hub-mode')).toContain('data-hub-mode="standby"');
    expect(html).toContain(WRITER_SUFFIX);
    expect(html).toContain('nodes.machine.writerHub');
  });

  test('两台 hub：列表 writer 打头，离线那台带离线标记', () => {
    const writer = hubRow({ nodeId: 'h1', name: 'hub-a', writerEpoch: 3 });
    const standby = hubRow({
      nodeId: 'h2',
      name: 'hub-b',
      mode: 'standby',
      priority: -1,
      online: false,
    });
    setMeshHubsStateForTest({
      hubs: [standby, writer],
      attached: attachedTo(writer),
      writerHubId: 'h1',
      loadedAt: 1,
    });
    const html = render(meshStatus('node'), MESH_MODE);
    expect(html).toContain(HUB_LIST_ROW);
    expect(html).toContain('nodes.machine.hubList');
    // 优先级更高的备 hub 也要排在 writer 后面
    expect(html.indexOf('local-machine-hub-item-h1')).toBeLessThan(
      html.indexOf('local-machine-hub-item-h2')
    );
    expect(tagOf(html, 'local-machine-hub-item-h2')).toContain('data-hub-online="false"');
    expect(html).toContain('data-testid="local-machine-hub-offline-h2"');
    expect(html).not.toContain('data-testid="local-machine-hub-offline-h1"');
    expect(tagOf(html, 'local-machine-hub-item-h1')).toContain('data-hub-online="true"');
  });

  test('hub 兼节点且自己就是 writer：当前 Hub 显示本机', () => {
    setMeshHubsStateForTest({
      hubs: [hubRow({ nodeId: MESH_MODE.nodeId, name: 'hub-a', writerEpoch: 2 })],
      attached: null,
      writerHubId: MESH_MODE.nodeId,
      loadedAt: 1,
    });
    const html = render(meshStatus('hub,node'), MESH_MODE);
    expect(html).toContain(ATTACHED_ROW);
    expect(html).toContain('nodes.machine.self');
    expect(html).not.toContain('>hub-a<');
    // 挂在自己身上时不重复地址，本机地址那一行已经给过
    expect(html).not.toContain('data-testid="local-machine-attached-hub-url"');
    expect(html).not.toContain(WRITER_SUFFIX);
    // 主 / 备身份那一行照旧
    expect(html).toContain('data-testid="local-machine-hub-mode"');
  });

  test('没挂上任何 Hub：当前 Hub 显示未连接，不展示入会种子，仍可更换 Hub', () => {
    const html = render(meshStatus('node'), MESH_MODE);
    expect(html).not.toContain(ATTACHED_ROW);
    expect(html).not.toContain(HUB_LIST_ROW);
    expect(html).toContain('nodes.machine.currentHub');
    // 入会种子不能冒充「当前 Hub」：那台机器可能早就不在了
    expect(html).toContain('data-testid="local-machine-hub-disconnected"');
    expect(html).toContain('nodes.machine.hubDisconnected');
    expect(html).not.toContain(JOIN_SEED_ROW);
    expect(html).not.toContain('nodes.machine.joinSeed');
    expect(html).toContain('data-testid="local-machine-change-hub"');
  });

  test('集合里没有挂载的那一行时用 attached 的地址，而不是入会种子', () => {
    setMeshHubsStateForTest({
      hubs: [hubRow({ nodeId: 'h1', name: 'hub-a' })],
      attached: {
        hubNodeId: 'h9',
        publicUrl: 'https://hub-new.example',
        mode: 'active',
        writerEpoch: 4,
        since: 1,
      },
      writerHubId: 'h1',
      loadedAt: 1,
    });
    const html = render(meshStatus('node'), MESH_MODE);
    expect(html).toContain('data-testid="local-machine-attached-hub-url"');
    expect(html).toContain('>https://hub-new.example<');
    expect(html).not.toContain('nodes.machine.hubDisconnected');
    // 种子与它不是同一台，但界面上不再出现种子
    expect(html).not.toContain(JOIN_SEED_ROW);
  });

  test('挂载信息连地址都没有：仍判未连接', () => {
    setMeshHubsStateForTest({
      hubs: [hubRow({ nodeId: 'h1', name: 'hub-a' })],
      attached: {
        hubNodeId: 'h9',
        publicUrl: '',
        mode: 'active',
        writerEpoch: 4,
        since: 1,
      },
      writerHubId: 'h1',
      loadedAt: 1,
    });
    const html = render(meshStatus('node'), MESH_MODE);
    expect(html).toContain('data-testid="local-machine-hub-disconnected"');
  });

  test('种子与挂载地址不一致也不展示入会种子，当前 Hub 只反映实际挂靠', () => {
    const hub = hubRow({ nodeId: 'h1', name: 'hub-a', publicUrl: 'https://hub-b.example' });
    setMeshHubsStateForTest({
      hubs: [hub],
      attached: attachedTo(hub),
      writerHubId: 'h1',
      loadedAt: 1,
    });
    // meshStatus('node') 的种子是 https://hub.example，与挂载的 hub-b 不是同一台
    const moved = render(meshStatus('node'), MESH_MODE);
    expect(moved).not.toContain(JOIN_SEED_ROW);
    expect(moved).not.toContain('nodes.machine.joinSeed');
    expect(moved).not.toContain('https://hub.example<');
    expect(moved).toContain(ATTACHED_ROW);
    expect(moved).toContain('>hub-a<');

    const same = hubRow({ nodeId: 'h1', name: 'hub-a', publicUrl: 'https://hub.example/' });
    setMeshHubsStateForTest({
      hubs: [same],
      attached: attachedTo(same),
      writerHubId: 'h1',
      loadedAt: 1,
    });
    expect(render(meshStatus('node'), MESH_MODE)).not.toContain(JOIN_SEED_ROW);
  });

  test('地址行的三语键：本机地址 / 当前 Hub', () => {
    expect(zhCN.translation.nodes.machine.localAddress).toBe('本机地址');
    expect(enUS.translation.nodes.machine.localAddress).toBe("This Machine's Address");
    expect(zhCN.translation.nodes.machine.currentHub).toBe('当前 Hub');
    expect(zhCN.translation.nodes.machine.hubDisconnected).toBe('未连接');
    expect(enUS.translation.nodes.machine.hubDisconnected).toBe('Not connected');
    expect(zhCN.translation.nodes.machine.hubList).toBe('Hub 列表');
    expect(zhCN.translation.nodes.machine.self).toBe('本机');
    expect(zhCN.translation.nodes.machine.writerHub).toContain('写者');
  });
});

describe('LocalMachineCard 的通用设置：允许域名访问', () => {
  const ROW = 'data-testid="local-machine-domain-access-switch"';

  function withDomainAccess(policy: DomainAccessPolicy | undefined): LocalStatusResponse {
    const base = meshStatus('hub,node');
    if (policy) return { ...base, domainAccess: policy };
    // 旧节点根本不下发该字段
    const { domainAccess: _omitted, ...rest } = base;
    return rest as LocalStatusResponse;
  }

  test('旧节点不下发该字段时整块不渲染', () => {
    const html = render(withDomainAccess(undefined), MESH_MODE);
    expect(html).not.toContain(ROW);
    expect(html).not.toContain('nodes.machine.general');
  });

  test('有公开域名：通用设置标题 + 开关 + 说明', () => {
    const html = render(
      withDomainAccess({ allowed: true, viaDomain: false, hosts: ['tmex.example.com'] }),
      MESH_MODE
    );
    expect(html).toContain('data-testid="local-machine-general-heading"');
    expect(html).toContain('nodes.machine.general');
    expect(html).toContain('nodes.machine.domainAccess.label');
    expect(html).toContain('nodes.machine.domainAccess.description');
    expect(switchState(html, 'local-machine-domain-access-switch')).toEqual({
      disabled: false,
      checked: true,
    });
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
  function harness(outcome: (allowed: boolean) => DomainAccessPolicy | Error) {
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
    const h = harness(() => policy(true));
    await h.controller.request(true);
    expect(h.calls).toEqual([true]);
    expect(h.results).toEqual([policy(true)]);
    expect(h.refreshCount()).toBe(1);
    expect(h.controller.snapshot().confirming).toBe(false);
  });

  test('关闭先确认：确认前不发请求', async () => {
    const h = harness(() => policy(false));
    await h.controller.request(false);
    expect(h.controller.snapshot().confirming).toBe(true);
    expect(h.calls).toEqual([]);

    await h.controller.confirm();
    expect(h.calls).toEqual([false]);
    expect(h.controller.snapshot().confirming).toBe(false);
    expect(h.refreshCount()).toBe(1);
  });

  test('取消确认不发请求', async () => {
    const h = harness(() => policy(false));
    await h.controller.request(false);
    h.controller.cancel();
    await h.controller.confirm();
    expect(h.calls).toEqual([]);
    expect(h.refreshCount()).toBe(0);
  });

  test('失败时留下错误，不刷新状态', async () => {
    const failure = new Error('domain_access_update_failed');
    const h = harness(() => failure);
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
