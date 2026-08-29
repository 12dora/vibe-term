// 本机区块的直连插件区：四种状态的静态渲染，加上安装 / 删除 / 启停的动作流。
// 无 DOM 测试环境，渲染用 react-dom/server，交互行为直接驱动 `DirectMutationController`
// （它就是为了脱离 DOM 可测才被拆成可订阅控制器的）。

import { describe, expect, test } from 'bun:test';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import { LocalApiError } from '@tmex/api-client/local/local-api';
import type {
  LocalDirectAction,
  LocalDirectResponse,
  LocalDirectStatus,
  LocalRole,
  LocalStatusResponse,
} from '@tmex/api-client/local/types';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import {
  type DirectApi,
  type DirectMutationCallbacks,
  DirectMutationController,
  LocalMachineCard,
  describeDirectError,
} from './local-machine-card';

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
  };
}

const idleApi: DirectApi = {
  setDirect: () => Promise.reject(new Error('unexpected call')),
};

function render(local: LocalStatusResponse | null, mode: AuthModeResponse | null = null): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <LocalMachineCard
        mode={mode}
        status={local}
        loading={false}
        loginRequired={false}
        api={idleApi}
        onRefresh={() => undefined}
      />
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
  test('平台不支持：只有不支持徽章，按钮与开关都禁用', () => {
    const html = render(status({ supported: false, platform: 'linux-riscv64' }));
    expect(html).toContain('data-testid="local-machine-direct-unsupported"');
    expect(html).not.toContain('data-testid="local-machine-direct-supported"');
    expect(html).not.toContain('data-testid="local-machine-direct-installed"');
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
    expect(html).toContain('data-testid="local-machine-direct-supported"');
    expect(tagOf(html, 'local-machine-direct-installed')).toBeTruthy();
    expect(html).toContain('nodes.machine.directNotInstalled');
    expect(html).toContain('data-testid="local-machine-direct-install"');
    expect(html).not.toContain('data-testid="local-machine-direct-remove"');
    expect(buttonDisabled(html, 'local-machine-direct-install')).toBe(false);
    expect(switchState(html, 'local-machine-direct-switch')).toEqual({
      disabled: true,
      checked: false,
    });
    expect(html).toContain('data-testid="local-machine-direct-hint"');
    expect(html).not.toContain('data-testid="local-machine-direct-active"');
    expect(html).not.toContain('data-testid="local-machine-direct-disabled"');
  });

  test('已安装且启用：版本徽章 + 生效徽章，删除按钮与打开的开关', () => {
    const html = render(
      status({ installed: true, enabled: true, capable: true, version: '0.4.2' })
    );
    expect(html).toContain('nodes.machine.directInstalledVersion');
    expect(html).toContain('data-testid="local-machine-direct-active"');
    expect(html).not.toContain('data-testid="local-machine-direct-disabled"');
    expect(html).toContain('data-testid="local-machine-direct-remove"');
    expect(html).not.toContain('data-testid="local-machine-direct-install"');
    expect(buttonDisabled(html, 'local-machine-direct-remove')).toBe(false);
    expect(switchState(html, 'local-machine-direct-switch')).toEqual({
      disabled: false,
      checked: true,
    });
    expect(html).not.toContain('data-testid="local-machine-direct-hint"');
  });

  test('已安装但关闭：关闭徽章，开关可用且处于关闭态', () => {
    const html = render(
      status({ installed: true, enabled: false, capable: false, version: '0.4.2' })
    );
    expect(html).toContain('data-testid="local-machine-direct-disabled"');
    expect(html).not.toContain('data-testid="local-machine-direct-active"');
    expect(html).toContain('data-testid="local-machine-direct-remove"');
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

  test('纯 node：hub 地址行给出「更换 Hub」', () => {
    const html = render(meshStatus('node'), MESH_MODE);
    expect(html).toContain('data-testid="local-machine-hub-url"');
    expect(html).toContain('data-testid="local-machine-change-hub"');
    expect(html).toContain('nodes.membership.changeHub');
    expect(buttonDisabled(html, 'local-machine-change-hub')).toBe(false);
  });

  test('hub 兼节点：公开地址只读，没有换 hub 入口', () => {
    const html = render(meshStatus('hub,node'), MESH_MODE);
    expect(html).toContain('data-testid="local-machine-hub-public-url"');
    expect(html).not.toContain('data-testid="local-machine-change-hub"');
    // 角色下拉照样可用
    expect(html).toContain('data-testid="local-machine-role"');
  });

  test('standalone：没有 hub 地址行，也没有换 hub 入口', () => {
    const html = render(status(), null);
    expect(html).not.toContain('data-testid="local-machine-hub-url"');
    expect(html).not.toContain('data-testid="local-machine-change-hub"');
    expect(html).toContain('nodes.machine.roleStandalone');
  });

  test('mesh 下只留账号安全入口，`/nodes` 整页已经移除', () => {
    const html = render(meshStatus('node'), MESH_MODE);
    expect(html).toContain('data-testid="local-machine-account-security"');
    expect(html).not.toContain('href="/nodes"');
    expect(html).not.toContain('nodes.machine.openNodesPage');
  });

  test('没有确认请求时不渲染退出对话框', () => {
    expect(render(meshStatus('node'), MESH_MODE)).not.toContain(
      'data-testid="membership-leave-dialog"'
    );
  });
});
