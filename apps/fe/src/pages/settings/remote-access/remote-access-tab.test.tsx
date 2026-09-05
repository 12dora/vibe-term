// 「远程访问」标签的静态渲染：远端路由拦截、加载 / 未登录 / 失败分支、状态与 Access 徽标矩阵、
// 连接方式分叉（Cloudflare Tunnel / 直接连接）、向导步进、暴露警示与确认、Cloudflare Access 区块、系统隧道接管。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 HttpsSection / SettingsPage 测试同一套做法）。

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import type {
  LocalAuthStatus,
  TunnelAccessMode,
  TunnelJobStatus,
  TunnelMode,
  TunnelProcessState,
  TunnelStatusResponse,
} from '@tmex/shared';
import { installWindowStorage } from '@tmex/stores/test-utils';
import { EXPOSURE_ACK, type ExposureState } from './exposure';
import type { NamedDraft } from './named-step';
import type { TunnelActions } from './tunnel-actions';

installWindowStorage();

let status: TunnelStatusResponse | null = null;
let loading = false;
let loginRequired = false;
let loadError: string | null = null;
type ActionSnapshot = Omit<TunnelActions, 'run' | 'clearError'>;

const IDLE_ACTIONS: ActionSnapshot = {
  pending: null,
  error: null,
  failedRequest: null,
  checkJobId: null,
  check: null,
  checking: false,
  busy: false,
};

let actionState: ActionSnapshot = { ...IDLE_ACTIONS };

mock.module('./use-tunnel-status', () => ({
  TUNNEL_STATUS_QUERY_KEY: ['tunnel-status'],
  useTunnelStatus: () => ({
    status,
    loading,
    loginRequired,
    error: loadError,
    refresh: () => undefined,
    setStatus: () => undefined,
  }),
}));

// 锁与结果处理在 tunnel-actions.test.ts 里测；这里只驱动它的输出，验证忙态真的落到控件上。
const actualActions = await import('./tunnel-actions');
mock.module('./tunnel-actions', () => ({
  ...actualActions,
  useTunnelActions: () => ({ ...actionState, run: () => undefined, clearError: () => undefined }),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('@/node/mesh-nodes');
const { RemoteAccessTab } = await import('./remote-access-tab');
const { TunnelStatusCard } = await import('./status-card');
const { TunnelWizard } = await import('./wizard');

const SELF_ID = 'a'.repeat(32);
const OTHER_ID = 'b'.repeat(32);

function tunnel(overrides: Partial<TunnelStatusResponse> = {}): TunnelStatusResponse {
  return {
    supported: true,
    platform: 'darwin-arm64',
    binary: { installed: true, version: '2026.1.0', path: '/data/cloudflared', source: 'managed' },
    auth: { loggedIn: false, loginUrl: null },
    config: {
      mode: 'off',
      hostname: null,
      tunnelName: null,
      tunnelId: null,
      autoStart: false,
      externallyManaged: false,
      originPort: 9883,
      accessMode: null,
    },
    process: {
      state: 'stopped',
      pid: null,
      startedAt: null,
      publicUrl: null,
      lastError: null,
      restarts: 0,
    },
    connector: {
      reachable: null,
      metricsAddr: null,
      readyConnections: null,
      connectorId: null,
      checkedAt: null,
      lastError: null,
    },
    access: {
      hasCredentials: false,
      accountId: null,
      teamDomain: null,
      configured: false,
      appId: null,
      aud: null,
      hostname: null,
      rules: [],
      enforceJwt: true,
      effective: false,
      bypassAppId: null,
      lastError: null,
    },
    external: {
      detected: false,
      source: null,
      configPath: null,
      tunnelId: null,
      tunnelName: null,
      hostnames: [],
      hasOriginCert: false,
      running: false,
    },
    loginEnforced: true,
    exposureProtected: true,
    job: null,
    trustProxy: false,
    configuredTrustProxy: false,
    restartRequired: false,
    log: [],
    ...overrides,
  };
}

function configured(
  mode: Exclude<TunnelMode, 'off'>,
  state: TunnelProcessState,
  overrides: Partial<TunnelStatusResponse> = {}
): TunnelStatusResponse {
  const base = tunnel(overrides);
  return {
    ...base,
    config: { ...base.config, mode, hostname: mode === 'named' ? 'tmex.example.com' : null },
    process: { ...base.process, state },
  };
}

/** 访问控制步选定 Cloudflare Access：Access 配置区块只在这一档展开。 */
function withCloudflareAccess(base: TunnelStatusResponse): TunnelStatusResponse {
  return { ...base, config: { ...base.config, accessMode: 'cloudflare' } };
}

function job(overrides: Partial<TunnelJobStatus> = {}): TunnelJobStatus {
  return {
    id: 'j1',
    kind: 'install',
    state: 'running',
    step: null,
    error: null,
    startedAt: '2026-08-30T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

function render(entry = '/settings'): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[entry]}>
      <RemoteAccessTab />
    </MemoryRouter>
  );
}

/** 只看标签自身的 `disabled=""`：class 里的 `disabled:` 变体前缀不算数。 */
function isDisabled(html: string, testId: string): boolean {
  const tag = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html);
  if (!tag) throw new Error(`missing element: ${testId}`);
  return / disabled=""/.test(tag[0]);
}

/** 开关渲染成 span，禁用态落在 `aria-disabled` 上，不是标签的 `disabled` 属性。 */
function isSwitchDisabled(html: string, testId: string): boolean {
  const tag = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html);
  if (!tag) throw new Error(`missing element: ${testId}`);
  return tag[0].includes('aria-disabled="true"');
}

/** 开关的选中态只看 `aria-checked`：class 里的 `data-checked:` 变体前缀不算数。 */
function isChecked(html: string, testId: string): boolean {
  const tag = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html);
  if (!tag) throw new Error(`missing element: ${testId}`);
  return tag[0].includes('aria-checked="true"');
}

function stepStateOf(html: string, testId: string): string | null {
  const tag = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html);
  if (!tag) throw new Error(`missing element: ${testId}`);
  return /data-step-state="([a-z]+)"/.exec(tag[0])?.[1] ?? null;
}

/** 向导里步骤卡出现的先后顺序。 */
function stepOrder(html: string): string[] {
  return [...html.matchAll(/data-testid="remote-access-step-([a-z]+)"/g)].map((m) => m[1] ?? '');
}

beforeEach(() => {
  status = tunnel();
  loading = false;
  loginRequired = false;
  loadError = null;
  actionState = { ...IDLE_ACTIONS };
  resetMeshNodesStateForTest();
});

describe('路由与加载分支', () => {
  test('浏览远端 node 时只给提示，不渲染状态卡与向导', () => {
    const html = render(`/n/${OTHER_ID}/settings`);
    expect(html).toContain('data-testid="remote-access-remote-node"');
    expect(html).toContain('settings.remoteAccess.remoteNodeNotice');
    expect(html).not.toContain('data-testid="remote-access-status"');
    expect(html).not.toContain('data-testid="remote-access-wizard"');
  });

  test('未登录时给登录提示', () => {
    loginRequired = true;
    const html = render();
    expect(html).toContain('data-testid="remote-access-login-required"');
    expect(html).not.toContain('data-testid="remote-access-wizard"');
  });

  test('加载中只转圈', () => {
    loading = true;
    status = null;
    const html = render();
    expect(html).toContain('data-testid="settings-remote-access-tab"');
    expect(html).not.toContain('data-testid="remote-access-status"');
  });

  test('加载失败展示错误而不是空白', () => {
    status = null;
    loadError = 'boom';
    const html = render();
    expect(html).toContain('data-testid="remote-access-load-failed"');
    expect(html).toContain('boom');
  });
});

describe('状态徽标与操作按钮', () => {
  test('未配置：徽标为未配置，且不出现启停 / 移除按钮', () => {
    const html = renderStatusCard();
    expect(html).toContain('settings.remoteAccess.state.notConfigured');
    expect(html).not.toContain('data-testid="remote-access-start"');
    expect(html).not.toContain('data-testid="remote-access-remove"');
  });

  test('已停止：可启动、可移除，没有停止与连通性检查', () => {
    status = configured('quick', 'stopped');
    const html = render();
    expect(html).toContain('settings.remoteAccess.state.stopped');
    expect(html).toContain('data-testid="remote-access-start"');
    expect(html).toContain('data-testid="remote-access-remove"');
    expect(html).not.toContain('data-testid="remote-access-stop"');
    expect(html).not.toContain('data-testid="remote-access-check"');
  });

  test('启动中：只给停止，不给连通性检查', () => {
    status = configured('quick', 'starting');
    const html = render();
    expect(html).toContain('settings.remoteAccess.state.starting');
    expect(html).toContain('data-testid="remote-access-stop"');
    expect(html).not.toContain('data-testid="remote-access-start"');
    expect(html).not.toContain('data-testid="remote-access-check"');
  });

  test('运行中：公网地址、复制、新标签页打开、连通性检查与重启次数', () => {
    status = configured('quick', 'running');
    status.process.publicUrl = 'https://calm-fox.trycloudflare.com';
    status.process.restarts = 2;
    const html = render();
    expect(html).toContain('settings.remoteAccess.state.running');
    expect(html).toContain('https://calm-fox.trycloudflare.com');
    expect(html).toContain('data-testid="remote-access-public-url-copy"');
    expect(html).toContain('data-testid="remote-access-open"');
    expect(html).toContain('data-testid="remote-access-check"');
    expect(html).toContain('data-testid="remote-access-restarts"');
    expect(html).toContain('settings.remoteAccess.mode.quick.title');
  });

  test('重启次数为 0 时不显示这一行', () => {
    status = configured('named', 'running');
    const html = render();
    expect(html).not.toContain('data-testid="remote-access-restarts"');
  });

  test('错误态展示进程最后一次错误', () => {
    status = configured('named', 'error');
    status.process.lastError = 'exit status 1';
    const html = render();
    expect(html).toContain('settings.remoteAccess.state.error');
    expect(html).toContain('data-testid="remote-access-process-error"');
    expect(html).toContain('exit status 1');
  });

  test('忙锁：所有操作按钮同时禁用', () => {
    status = configured('quick', 'running');
    actionState = { ...IDLE_ACTIONS, pending: 'stop', busy: true };
    const html = render();
    expect(isDisabled(html, 'remote-access-stop')).toBe(true);
    expect(isDisabled(html, 'remote-access-check')).toBe(true);
    expect(isDisabled(html, 'remote-access-remove')).toBe(true);
  });

  test('检查受理后先给中性的「检查中」，不提前报可访问', () => {
    status = configured('quick', 'running');
    actionState = { ...IDLE_ACTIONS, checkJobId: 'check-1', checking: true };
    const html = render();
    expect(html).toContain('data-testid="remote-access-check-running"');
    expect(html).not.toContain('data-testid="remote-access-check-ok"');
    expect(html).not.toContain('data-testid="remote-access-check-failed"');
  });

  test('检查 job 到达终态后就地展示结果', () => {
    status = configured('quick', 'running');
    actionState = {
      ...IDLE_ACTIONS,
      checkJobId: 'check-1',
      check: { ok: true, message: null, step: 'ok', code: null },
    };
    expect(render()).toContain('data-testid="remote-access-check-ok"');

    actionState = {
      ...IDLE_ACTIONS,
      checkJobId: 'check-1',
      check: { ok: false, message: '502 bad gateway', step: 'check', code: 'unknown' },
    };
    const html = render();
    expect(html).toContain('data-testid="remote-access-check-failed"');
    expect(html).toContain('502 bad gateway');
  });

  test('命名隧道的移除要先过确认对话框', () => {
    status = configured('named', 'running');
    const html = render();
    expect(html).toContain('data-testid="remote-access-remove"');
    // 静态渲染点不了按钮，对话框默认不在 DOM 里。
    expect(html).not.toContain('data-testid="remote-access-confirm-remove"');
  });
});

describe('无边缘连接（degraded）', () => {
  function connector(
    overrides: Partial<TunnelStatusResponse['connector']> = {}
  ): TunnelStatusResponse['connector'] {
    return {
      reachable: true,
      metricsAddr: '127.0.0.1:20241',
      readyConnections: 4,
      connectorId: 'c-1',
      checkedAt: '2026-09-02T00:00:00.000Z',
      lastError: null,
      ...overrides,
    };
  }

  test('进程 degraded：徽标另有说法，给出警示，检查按钮仍在', () => {
    status = configured('named', 'degraded');
    const html = render();
    expect(html).toContain('settings.remoteAccess.state.degraded');
    expect(html).not.toContain('settings.remoteAccess.state.running');
    expect(html).toContain('data-testid="remote-access-degraded"');
    expect(html).toContain('settings.remoteAccess.degradedNotice');
    expect(html).toContain('data-testid="remote-access-check"');
  });

  test('进程说运行中但连接器零连接：同样降级', () => {
    status = configured('named', 'running', { connector: connector({ readyConnections: 0 }) });
    const html = render();
    expect(html).toContain('settings.remoteAccess.state.degraded');
    expect(html).toContain('data-testid="remote-access-degraded"');
  });

  test('警示第二行给出进程或连接器的最近一次错误', () => {
    status = configured('named', 'degraded');
    status.process.lastError = 'connection refused';
    expect(render()).toContain('connection refused');

    status = configured('named', 'degraded', {
      connector: connector({ readyConnections: 0, lastError: 'failed to dial edge' }),
    });
    const html = render();
    expect(html).toContain('data-testid="remote-access-degraded-error"');
    expect(html).toContain('failed to dial edge');
  });

  test('确证零连接时补一条排查指引；探不到连接数时不给', () => {
    status = configured('named', 'running', {
      connector: connector({ readyConnections: 0 }),
    });
    const zero = render();
    expect(zero).toContain('data-testid="remote-access-degraded-hint"');
    expect(zero).toContain('settings.remoteAccess.degradedHint');

    // 进程自报 degraded，但连接器没给出连接数：只说结论，不指向 7844。
    status = configured('named', 'degraded');
    const unknown = render();
    expect(unknown).toContain('settings.remoteAccess.degradedNotice');
    expect(unknown).not.toContain('data-testid="remote-access-degraded-hint"');
  });

  test('fake-IP 劫持已绕开：警示改说走的是真实边缘地址，不再给通用的 7844 指引', () => {
    status = configured('named', 'degraded', {
      connector: connector({ readyConnections: 0 }),
      edge: {
        mode: 'static',
        fakeIpDetected: true,
        edgeAddrs: ['198.41.192.7:7844'],
        checkedAt: '2026-09-05T00:00:00.000Z',
        lastError: null,
      },
    });
    const html = render();
    expect(html).toContain('data-testid="remote-access-edge-bypassed"');
    expect(html).toContain('settings.remoteAccess.edge.bypassed');
    expect(html).not.toContain('data-testid="remote-access-degraded-hint"');
    // 连接器旁多一行，说明当前用的是静态边缘地址。
    expect(html).toContain('data-testid="remote-access-edge"');
    expect(html).toContain('settings.remoteAccess.edge.staticActive');
  });

  test('检测到 fake-IP 但绕不开：给代理侧的具体改法，并带上解析错误', () => {
    status = configured('named', 'degraded', {
      connector: connector({ readyConnections: 0 }),
      edge: {
        mode: 'system',
        fakeIpDetected: true,
        edgeAddrs: [],
        checkedAt: '2026-09-05T00:00:00.000Z',
        lastError: 'DoH query failed',
      },
    });
    const html = render();
    expect(html).toContain('data-testid="remote-access-edge-fakeip"');
    expect(html).toContain('settings.remoteAccess.edge.bypassFailed');
    expect(html).toContain('data-testid="remote-access-edge-fix"');
    expect(html).toContain('settings.remoteAccess.edge.bypassFailedFix');
    expect(html).toContain('settings.remoteAccess.edge.bypassFailedRetry');
    expect(html).toContain('data-testid="remote-access-degraded-error"');
    expect(html).toContain('DoH query failed');
    expect(html).not.toContain('data-testid="remote-access-degraded-hint"');
    // 没绕开就不该说自己在走真实边缘地址。
    expect(html).not.toContain('settings.remoteAccess.edge.staticActive');
  });

  test('解析正常：沿用通用指引，连接器旁不多这一行', () => {
    status = configured('named', 'running', {
      connector: connector({ readyConnections: 0 }),
      edge: {
        mode: 'system',
        fakeIpDetected: false,
        edgeAddrs: [],
        checkedAt: '2026-09-05T00:00:00.000Z',
        lastError: null,
      },
    });
    const html = render();
    expect(html).toContain('data-testid="remote-access-degraded-hint"');
    expect(html).not.toContain('data-testid="remote-access-edge-bypassed"');
    expect(html).not.toContain('data-testid="remote-access-edge-fakeip"');
    expect(html).not.toContain('data-testid="remote-access-edge"');
  });

  test('接管来的隧道零连接时也降级', () => {
    status = configured('named', 'stopped', {
      external: { ...tunnel().external, detected: true, running: true, source: 'launchd' },
      connector: connector({ readyConnections: 0 }),
    });
    status.config.externallyManaged = true;
    const html = render();
    expect(html).toContain('settings.remoteAccess.state.degraded');
    expect(html).toContain('data-testid="remote-access-check"');
  });

  test('连接器一行：有连接 / 无连接 / 探不到 / 未探测', () => {
    status = configured('named', 'running', { connector: connector() });
    const online = render();
    expect(online).toContain('data-testid="remote-access-connector"');
    expect(online).toContain('settings.remoteAccess.connector.connected');
    // metrics 地址只进 title，不占版面。
    expect(online).toContain('title="127.0.0.1:20241"');

    status = configured('named', 'running', { connector: connector({ readyConnections: 0 }) });
    const down = render();
    expect(down).toContain('settings.remoteAccess.connector.noConnections');
    expect(down).toContain('text-destructive');

    status = configured('named', 'running', {
      connector: connector({ reachable: null, readyConnections: null }),
    });
    expect(render()).toContain('settings.remoteAccess.connector.unknown');

    status = configured('named', 'running');
    expect(render()).toContain('settings.remoteAccess.connector.unprobed');
  });

  test('未配置时不摆连接器一行', () => {
    expect(renderStatusCard()).not.toContain('data-testid="remote-access-connector"');
  });
});

describe('检查结论', () => {
  test('ok / access_protected 都算成功', () => {
    status = configured('named', 'running');
    actionState = {
      ...IDLE_ACTIONS,
      checkJobId: 'check-1',
      check: { ok: true, message: null, step: 'ok', code: null },
    };
    expect(render()).toContain('settings.remoteAccess.check.reachable');

    actionState = {
      ...IDLE_ACTIONS,
      checkJobId: 'check-1',
      check: { ok: true, message: null, step: 'access_protected', code: null },
    };
    const html = render();
    expect(html).toContain('data-testid="remote-access-check-ok"');
    expect(html).toContain('settings.remoteAccess.check.accessProtected');
  });

  test('Access 拦下且探不到连接器：警示而不是报喜', () => {
    status = configured('named', 'running');
    actionState = {
      ...IDLE_ACTIONS,
      checkJobId: 'check-1',
      check: { ok: true, message: null, step: 'access_protected_unverified', code: null },
    };
    const html = render();
    expect(html).toContain('data-testid="remote-access-check-warning"');
    expect(html).toContain('settings.remoteAccess.check.accessProtectedUnverified');
    expect(html).not.toContain('data-testid="remote-access-check-ok"');
  });

  test('connector_down 用连接器专属文案', () => {
    status = configured('named', 'running');
    actionState = {
      ...IDLE_ACTIONS,
      checkJobId: 'check-1',
      check: {
        ok: false,
        message: '0 edge connections',
        step: 'check',
        code: 'connector_down',
      },
    };
    const html = render();
    expect(html).toContain('data-testid="remote-access-check-failed"');
    expect(html).toContain('settings.remoteAccess.errors.connector_down');
    expect(html).not.toContain('settings.remoteAccess.check.unreachable');
  });
});

describe('Access 徽标', () => {
  // 诊断徽标只在「Access 没生效、也没有登录门」时才轮得到：有登录门时徽标先报登录保护。
  test('未配置 / 已配置但未强制 / 主机名不匹配 / 已保护四态', () => {
    status = withCloudflareAccess(tunnel({ loginEnforced: false }));
    expect(renderStatusCard()).toContain('settings.remoteAccess.accessState.notConfigured');

    status = configured('named', 'running', {
      loginEnforced: false,
      access: { ...tunnel().access, configured: true, enforceJwt: false },
    });
    expect(render()).toContain('settings.remoteAccess.accessState.notEnforced');

    // 应用还绑在被移除的旧隧道上：不能报「已保护」。
    status = configured('named', 'running', {
      loginEnforced: false,
      access: {
        ...tunnel().access,
        configured: true,
        enforceJwt: true,
        hostname: 'old.example.com',
        effective: false,
      },
    });
    expect(render()).toContain('settings.remoteAccess.accessState.hostnameMismatch');

    status = configured('named', 'running', {
      access: {
        ...tunnel().access,
        configured: true,
        enforceJwt: true,
        hostname: 'tmex.example.com',
        effective: true,
      },
    });
    expect(render()).toContain('settings.remoteAccess.accessState.protected');
  });

  test('有登录门时先报登录保护，Access 的诊断让位', () => {
    status = configured('named', 'running', {
      loginEnforced: true,
      access: { ...tunnel().access, configured: true, enforceJwt: false },
    });
    expect(render()).toContain('settings.remoteAccess.accessState.loginProtected');
  });
});

describe('Access 只读探测', () => {
  const probe = (
    over: Partial<NonNullable<TunnelStatusResponse['external']['externalAccess']>> = {}
  ) => ({ checked: true, hostnameMatch: false, appId: null, aud: null, teamDomain: null, ...over });

  const withProbe = (
    externalAccess: TunnelStatusResponse['external']['externalAccess'] | undefined
  ) =>
    withCloudflareAccess(
      configured('named', 'running', {
        loginEnforced: false,
        external: { ...tunnel().external, externalAccess },
      })
    );

  test('控制台已覆盖：徽标与说明都不能说成 tmex 托管', () => {
    status = withProbe(
      probe({ hostnameMatch: true, appId: 'app-1', teamDomain: 'team.cloudflareaccess.com' })
    );
    const html = render();
    expect(html).toContain('settings.remoteAccess.accessState.dashboardCovered');
    expect(html).toContain('data-testid="remote-access-access-probe-covered"');
    expect(html).toContain('data-testid="remote-access-access-probe-team"');
  });

  test('查不了时不显示「未配置」', () => {
    status = withProbe(probe({ checked: false }));
    const html = render();
    expect(html).toContain('settings.remoteAccess.accessState.unknown');
    expect(html).toContain('data-testid="remote-access-access-probe-unknown"');
    expect(html).not.toContain('settings.remoteAccess.accessState.notConfigured');
  });

  test('查过了确实没有，才是「未配置」', () => {
    status = withProbe(probe());
    const html = render();
    expect(html).toContain('settings.remoteAccess.accessState.notConfigured');
    expect(html).toContain('data-testid="remote-access-access-probe-absent"');
  });

  test('探测到了但凭证没存过时，补一句「先保存凭证」——同步 / 应用按钮此刻还不在页面上', () => {
    status = withProbe(probe({ hostnameMatch: true }));
    expect(render()).toContain('data-testid="remote-access-access-probe-need-credentials"');

    const base = tunnel();
    status = withCloudflareAccess(
      configured('named', 'running', {
        access: { ...base.access, hasCredentials: true },
        external: { ...base.external, externalAccess: probe({ hostnameMatch: true }) },
      })
    );
    expect(render()).not.toContain('data-testid="remote-access-access-probe-need-credentials"');
  });

  test('tmex 已托管应用时不再渲染只读探测提示', () => {
    const base = tunnel();
    status = configured('named', 'running', {
      access: {
        ...base.access,
        configured: true,
        enforceJwt: true,
        hostname: 'tmex.example.com',
        effective: true,
      },
      external: { ...base.external, externalAccess: probe({ hostnameMatch: true }) },
    });
    const html = render();
    expect(html).toContain('settings.remoteAccess.accessState.protected');
    expect(html).not.toContain('data-testid="remote-access-access-probe-');
  });
});

describe('系统隧道接管', () => {
  const detected = (overrides: Partial<TunnelStatusResponse['external']> = {}) => ({
    ...tunnel().external,
    detected: true,
    source: 'launchd',
    configPath: '/Users/me/.cloudflared/config.yml',
    tunnelId: 'd8e1f0aa-0000-4000-8000-000000000000',
    tunnelName: 'home',
    hostnames: ['tmex.example.com'],
    hasOriginCert: true,
    running: true,
    ...overrides,
  });

  test('探测到系统隧道且本机未配置时，在向导顶部给接管卡', () => {
    status = tunnel({ external: detected() });
    const html = render();
    expect(html).toContain('data-testid="remote-access-external"');
    expect(html).toContain('settings.remoteAccess.external.sourceValue.launchd');
    expect(html).toContain('home');
    expect(html).toContain('tmex.example.com');
    expect(html).toContain('settings.remoteAccess.external.runningValue.on');
    expect(html).toContain('data-testid="remote-access-external-adopt"');
    expect(html).toContain('data-testid="remote-access-external-dismiss"');
    // 接管卡排在第 1 步之前。
    expect(html.indexOf('data-testid="remote-access-external"')).toBeLessThan(
      html.indexOf('data-testid="remote-access-step-path"')
    );
  });

  test('多个主机名时给下拉选择，没有主机名时不让接管', () => {
    status = tunnel({ external: detected({ hostnames: ['a.example.com', 'b.example.com'] }) });
    expect(render()).toContain('settings.remoteAccess.external.chooseHostname');

    status = tunnel({ external: detected({ hostnames: [] }) });
    const html = render();
    expect(html).toContain('data-testid="remote-access-external-no-hostname"');
    expect(isDisabled(html, 'remote-access-external-adopt')).toBe(true);
  });

  test('接管卡带上 Access 只读探测结果与接管说明', () => {
    status = tunnel({
      external: detected({
        externalAccess: {
          checked: true,
          hostnameMatch: true,
          appId: 'app-1',
          aud: 'aud-1',
          teamDomain: 'team.cloudflareaccess.com',
        },
      }),
    });
    const html = render();
    expect(html).toContain('settings.remoteAccess.external.accessValue.covered');
    expect(html).toContain('team.cloudflareaccess.com');
    expect(html).toContain('data-testid="remote-access-external-adopt-hint"');
  });

  test('没有可用凭证时接管卡写「无法检测」', () => {
    status = tunnel({ external: detected() });
    const html = render();
    expect(html).toContain('settings.remoteAccess.external.accessValue.unknown');
    expect(html).not.toContain('settings.remoteAccess.external.accessValue.absent');
  });

  test('已经配置过隧道时不再打扰', () => {
    status = configured('named', 'running', { external: detected() });
    expect(render()).not.toContain('data-testid="remote-access-external"');
  });

  test('接管之后：状态卡打「由系统服务托管」，只留检查与取消接管', () => {
    status = configured('named', 'stopped', { external: detected() });
    status.config.externallyManaged = true;
    const html = render();
    expect(html).toContain('data-testid="remote-access-managed"');
    expect(html).toContain('data-testid="remote-access-managed-notice"');
    expect(html).toContain('data-testid="remote-access-check"');
    expect(html).toContain('data-testid="remote-access-release"');
    expect(html).not.toContain('data-testid="remote-access-start"');
    expect(html).not.toContain('data-testid="remote-access-stop"');
    expect(html).not.toContain('data-testid="remote-access-remove"');
    // 运行态以探测结果为准，tmex 侧没有进程。
    expect(html).toContain('settings.remoteAccess.state.running');
  });

  test('接管之后安装与登录两步显示为跳过', () => {
    status = configured('named', 'stopped', {
      binary: { installed: false, version: null, path: null, source: null },
      external: detected(),
    });
    status.config.externallyManaged = true;
    const html = render();
    expect(html).toContain('data-testid="remote-access-install-skipped"');
    expect(html).toContain('data-testid="remote-access-login-skipped"');
    expect(stepStateOf(html, 'remote-access-step-install')).toBe('done');
    expect(stepStateOf(html, 'remote-access-step-login')).toBe('done');
    expect(html).toContain('settings.remoteAccess.steps.create.adopted');
  });
});

describe('暴露警示与确认', () => {
  test('未受保护时隧道类型步上方给出警示并链到多节点设置，但不带确认勾选', () => {
    status = tunnel({ loginEnforced: false, exposureProtected: false });
    const html = renderWizard('off');
    expect(html).toContain('data-testid="remote-access-exposure"');
    expect(html).toContain('settings.remoteAccess.exposure.warning');
    // 这一步没有会开放公网的动作：勾选只出现在真正发起动作的那几步旁边。
    expect(html).not.toContain('data-testid="remote-access-exposure-ack"');
    expect(html).toContain('?tab=nodes');
    expect(html.indexOf('data-testid="remote-access-exposure"')).toBeLessThan(
      html.indexOf('data-testid="remote-access-mode-chooser"')
    );
  });

  test('未受保护不禁用临时隧道选项，也不禁用启动按钮', () => {
    status = tunnel({ loginEnforced: false, exposureProtected: false });
    const html = renderWizard('off');
    expect(isDisabled(html, 'remote-access-mode-quick-input')).toBe(false);

    status = configured('quick', 'stopped', { loginEnforced: false, exposureProtected: false });
    const started = render();
    expect(isDisabled(started, 'remote-access-start')).toBe(false);
    expect(started).toContain('data-testid="remote-access-start-exposure"');
  });

  test('临时隧道与创建按钮旁各有一条精简警示', () => {
    status = tunnel({ loginEnforced: false, exposureProtected: false });
    expect(renderWizard('quick')).toContain('data-testid="remote-access-quick-exposure"');

    status = tunnel({
      auth: { loggedIn: true, loginUrl: null },
      loginEnforced: false,
      exposureProtected: false,
    });
    const html = renderWizard('named', { draft: namedDraft({ confirmed: true }) });
    expect(html).toContain('data-testid="remote-access-create-exposure"');
    expect(html).toContain('settings.remoteAccess.exposure.warningShort');
  });

  test('已受保护时一条警示都不出现', () => {
    status = configured('quick', 'stopped');
    const html = render();
    expect(html).not.toContain('data-testid="remote-access-exposure"');
    expect(html).not.toContain('data-testid="remote-access-start-exposure"');
  });

  test('后端回 exposure_ack_required 时给确认框而不是通用错误', () => {
    status = configured('quick', 'stopped');
    actionState = {
      ...IDLE_ACTIONS,
      error: { code: 'exposure_ack_required', message: 'ack required' },
    };
    const html = render();
    expect(html).not.toContain('data-testid="remote-access-error"');
    // 勾选属于「启动」这个动作：即便当前已受保护，被拒之后也要把它旁边那条警示亮出来。
    expect(html).toContain('data-testid="remote-access-start-exposure"');
    expect(html).toContain('data-testid="remote-access-start-exposure-required"');
    expect(html).toContain('data-testid="remote-access-start-exposure-ack"');
    expect(html).toContain(`id="${EXPOSURE_ACK.start}"`);
    // 动作旁已有确认勾选时，卡片顶部不再重复一条同样的警示。
    expect(html).not.toContain('data-testid="remote-access-status-exposure"');
  });

  test('409 的归属来自失败的那个请求：标签层把勾选接到对应的警示上', () => {
    const access = {
      ...tunnel().access,
      hasCredentials: true,
      configured: true,
      enforceJwt: true,
      hostname: 'tmex.example.com',
      effective: true,
      rules: [{ kind: 'email' as const, value: 'you@example.com' }],
    };
    status = configured('named', 'stopped', {
      auth: { loggedIn: true, loginUrl: null },
      access,
      loginEnforced: false,
    });
    actionState = {
      ...IDLE_ACTIONS,
      error: { code: 'exposure_ack_required', message: 'ack required' },
      failedRequest: { action: 'set_access_enforce', enforceJwt: false },
    };
    const html = render();
    expect(html).toContain('data-testid="remote-access-access-drop-exposure-ack"');
    expect(html).toContain(`id="${EXPOSURE_ACK.accessEnforce}"`);
    expect(isSwitchDisabled(html, 'remote-access-access-enforce')).toBe(true);
    // 被拒的是关校验，启动按钮旁那条不跟着亮。
    expect(html).not.toContain('data-testid="remote-access-start-exposure"');
  });

  test('收敛动作失败时不冒出任何勾选：归属为空就不兜底', () => {
    status = configured('quick', 'stopped');
    actionState = {
      ...IDLE_ACTIONS,
      error: { code: 'busy', message: 'another action is running' },
      failedRequest: { action: 'stop' },
    };
    const html = render();
    expect(html).toContain('data-testid="remote-access-error"');
    expect(html).not.toContain('data-testid="remote-access-start-exposure"');
  });

  test('确认框跟着动作走：隧道在跑时启动按钮不在，被拒的提示落回卡片顶部', () => {
    status = configured('quick', 'running');
    actionState = {
      ...IDLE_ACTIONS,
      error: { code: 'exposure_ack_required', message: 'ack required' },
    };
    const html = render();
    expect(html).toContain('data-testid="remote-access-status-exposure"');
    expect(html).toContain('data-testid="remote-access-status-exposure-required"');
    expect(html).not.toContain('data-testid="remote-access-start-exposure"');
  });
});

describe('错误码映射', () => {
  test('已知错误码走本地化文案', () => {
    actionState = {
      ...IDLE_ACTIONS,
      error: { code: 'busy', message: 'another action is running' },
    };
    const html = renderStatusCard();
    expect(html).toContain('data-testid="remote-access-error"');
    expect(html).toContain('settings.remoteAccess.errors.busy');
  });

  test('Access API 失败带上服务端 message', () => {
    actionState = {
      ...IDLE_ACTIONS,
      error: { code: 'access_api_failed', message: 'token lacks permission' },
    };
    expect(renderStatusCard()).toContain('settings.remoteAccess.errors.access_api_failed');
  });

  test('未知错误码退回带原始 message 的兜底文案', () => {
    actionState = { ...IDLE_ACTIONS, error: { code: 'unknown', message: 'network down' } };
    expect(renderStatusCard()).toContain('settings.remoteAccess.errors.unknown');
  });
});

describe('连接方式', () => {
  test('初始只给两张连接方式卡：没有安装步，也没有隧道状态卡', () => {
    const html = render();
    expect(stepOrder(html)).toEqual(['path']);
    expect(html).toContain('data-testid="remote-access-path-chooser"');
    expect(html).toContain('data-testid="remote-access-path-tunnel"');
    expect(html).toContain('data-testid="remote-access-path-direct"');
    expect(html).toContain('settings.remoteAccess.path.tunnel.description');
    expect(html).not.toContain('data-testid="remote-access-step-install"');
    expect(html).not.toContain('data-testid="remote-access-status"');
    expect(stepStateOf(html, 'remote-access-step-path')).toBe('current');
  });

  test('选中 Cloudflare Tunnel 后才展开安装与隧道类型两步', () => {
    const html = renderWizard('off');
    expect(stepOrder(html)).toEqual(['path', 'install', 'mode', 'tunnel', 'proxy']);
    expect(stepStateOf(html, 'remote-access-step-path')).toBe('done');
    expect(html).toContain('data-testid="remote-access-mode-chooser"');
  });

  test('选中直接连接后只剩访问保护一步，且不出现隧道状态卡', () => {
    const html = renderWizard('direct');
    expect(stepOrder(html)).toEqual(['path', 'direct']);
    expect(html).not.toContain('data-testid="remote-access-status"');
    expect(html).not.toContain('data-testid="remote-access-step-proxy"');
  });

  test('已建好隧道时连接方式锁死在隧道：两张卡都禁用，状态卡照常渲染', () => {
    status = configured('named', 'running');
    const html = render();
    expect(html).toContain('data-testid="remote-access-status"');
    expect(isDisabled(html, 'remote-access-path-tunnel-input')).toBe(true);
    expect(isDisabled(html, 'remote-access-path-direct-input')).toBe(true);
    expect(/data-testid="remote-access-path-tunnel"[^>]*data-selected="true"/.test(html)).toBe(
      true
    );
  });
});

describe('向导步进', () => {
  test('命名隧道的步骤顺序：连接方式 → 安装 → 隧道类型 → 登录 → 主机名 → 访问控制 → 创建 → 反向代理', () => {
    status = tunnel({ auth: { loggedIn: true, loginUrl: null } });
    expect(stepOrder(renderWizard('named'))).toEqual([
      'path',
      'install',
      'mode',
      'login',
      'hostname',
      'access',
      'create',
      'proxy',
    ]);
  });

  test('临时隧道没有登录 / 主机名 / 访问控制三步', () => {
    expect(stepOrder(renderWizard('quick'))).toEqual(['path', 'install', 'mode', 'quick', 'proxy']);
  });

  test('访问控制步带「推荐」（未启用登录）或「可选」（已启用登录）标签', () => {
    status = tunnel({ auth: { loggedIn: true, loginUrl: null }, loginEnforced: false });
    expect(renderWizard('named')).toContain('settings.remoteAccess.access.tag.recommended');

    status = tunnel({ auth: { loggedIn: true, loginUrl: null }, loginEnforced: true });
    expect(renderWizard('named')).toContain('settings.remoteAccess.access.tag.optional');
  });

  test('未安装 cloudflared 时停在安装步并给安装按钮', () => {
    status = tunnel({ binary: { installed: false, version: null, path: null, source: null } });
    const html = renderWizard('off');
    expect(stepStateOf(html, 'remote-access-step-install')).toBe('current');
    expect(stepStateOf(html, 'remote-access-step-mode')).toBe('todo');
    expect(html).toContain('data-testid="remote-access-install"');
  });

  test('不支持的平台只给提示，不给安装按钮', () => {
    status = tunnel({
      supported: false,
      platform: 'freebsd-x64',
      binary: { installed: false, version: null, path: null, source: null },
    });
    const html = renderWizard('off');
    expect(html).toContain('data-testid="remote-access-unsupported"');
    expect(html).not.toContain('data-testid="remote-access-install"');
  });

  test('安装 job 在跑时展示进度步骤', () => {
    status = tunnel({
      binary: { installed: false, version: null, path: null, source: null },
      job: job({ kind: 'install', state: 'running', step: 'download' }),
    });
    const html = renderWizard('off');
    expect(html).toContain('data-testid="remote-access-install-progress"');
    expect(html).toContain('settings.remoteAccess.jobStep.download');
  });

  test('安装 job 失败时映射错误码', () => {
    status = tunnel({
      binary: { installed: false, version: null, path: null, source: null },
      job: job({
        kind: 'install',
        state: 'error',
        error: { code: 'download_failed', message: 'timeout' },
      }),
    });
    expect(renderWizard('off')).toContain('settings.remoteAccess.errors.download_failed');
  });

  test('装好后停在隧道类型步：两张类型卡都在（没有直接连接卡），下一步等待选择', () => {
    const html = renderWizard('off');
    expect(stepStateOf(html, 'remote-access-step-install')).toBe('done');
    expect(stepStateOf(html, 'remote-access-step-mode')).toBe('current');
    expect(html).toContain('data-testid="remote-access-mode-quick"');
    expect(html).toContain('data-testid="remote-access-mode-named"');
    expect(html).not.toContain('data-testid="remote-access-mode-direct"');
    expect(html).toContain('data-testid="remote-access-step-tunnel-idle"');
    expect(html).toContain('data-testid="remote-access-binary"');
  });

  test('已建好隧道时类型卡锁定，向导停在反向代理步', () => {
    status = configured('named', 'running');
    const html = render();
    expect(stepStateOf(html, 'remote-access-step-create')).toBe('done');
    expect(stepStateOf(html, 'remote-access-step-proxy')).toBe('current');
    expect(isDisabled(html, 'remote-access-mode-named-input')).toBe(true);
    expect(isDisabled(html, 'remote-access-mode-quick-input')).toBe(true);
  });

  test('临时隧道启动后展示 trycloudflare 地址', () => {
    status = configured('quick', 'running');
    status.process.publicUrl = 'https://calm-fox.trycloudflare.com';
    const html = render();
    expect(html).toContain('data-testid="remote-access-quick-started"');
    expect(html).toContain('data-testid="remote-access-quick-url"');
    expect(html).not.toContain('data-testid="remote-access-quick-start"');
  });

  test('反向代理信任与随 tmex 启动两个开关都在；需要重启时给立即重启', () => {
    status = configured('quick', 'running', { restartRequired: true });
    const html = render();
    expect(html).toContain('data-testid="remote-access-trust-proxy"');
    expect(html).toContain('data-testid="remote-access-auto-start"');
    expect(html).toContain('data-testid="remote-access-restart-required"');
    expect(html).toContain('data-testid="remote-access-restart-now"');
  });

  test('接管来的隧道不给「随 tmex 启动」开关', () => {
    status = configured('named', 'stopped');
    status.config.externallyManaged = true;
    expect(render()).not.toContain('data-testid="remote-access-auto-start"');
  });

  test('信任开关绑已保存值，生效值单独展示', () => {
    // 刚保存完：已保存 true，进程仍按 false 跑。
    status = configured('quick', 'running', {
      configuredTrustProxy: true,
      trustProxy: false,
      restartRequired: true,
    });
    const html = render();
    expect(isChecked(html, 'remote-access-trust-proxy')).toBe(true);
    expect(html).toContain('data-testid="remote-access-trust-proxy-effective"');
    expect(html).toContain('settings.remoteAccess.steps.proxy.trustProxyState.off');
    expect(html).toContain('settings.remoteAccess.steps.proxy.trustProxyDetail');
  });

  test('已保存值与生效值不一致时即便后端没报 restartRequired 也提示重启', () => {
    status = configured('quick', 'running', { configuredTrustProxy: true, trustProxy: false });
    expect(render()).toContain('data-testid="remote-access-restart-required"');
  });

  test('不需要重启时不显示重启提示', () => {
    status = configured('quick', 'running');
    const html = render();
    expect(html).not.toContain('data-testid="remote-access-restart-required"');
    expect(isChecked(html, 'remote-access-trust-proxy')).toBe(false);
    expect(html).toContain('settings.remoteAccess.steps.proxy.trustProxyState.off');
  });
});

describe('命名隧道', () => {
  test('未登录时先给登录按钮', () => {
    status = tunnel();
    const html = renderWizard('named');
    expect(html).toContain('data-testid="remote-access-login-start"');
    expect(html).not.toContain('data-testid="remote-access-hostname"');
  });

  test('登录 job 在跑时展示授权地址、复制与取消', () => {
    status = tunnel({
      auth: { loggedIn: false, loginUrl: 'https://dash.cloudflare.com/argotunnel?a=1' },
      job: job({ kind: 'login', state: 'running' }),
    });
    const html = renderWizard('named');
    expect(html).toContain('data-testid="remote-access-login-waiting"');
    expect(html).toContain('https://dash.cloudflare.com/argotunnel?a=1');
    expect(html).toContain('data-testid="remote-access-login-url-copy"');
    expect(html).toContain('data-testid="remote-access-login-cancel"');
    expect(html).not.toContain('data-testid="remote-access-login-start"');
  });

  test('登录超时映射成本地化文案', () => {
    status = tunnel({
      job: job({
        kind: 'login',
        state: 'error',
        error: { code: 'login_timeout', message: 'timed out' },
      }),
    });
    expect(renderWizard('named')).toContain('settings.remoteAccess.errors.login_timeout');
  });

  test('登录后主机名步给出表单，创建步先等主机名确认', () => {
    status = tunnel({ auth: { loggedIn: true, loginUrl: null } });
    const html = renderWizard('named');
    expect(html).toContain('data-testid="remote-access-logged-in"');
    expect(html).toContain('data-testid="remote-access-hostname"');
    expect(html).toContain('data-testid="remote-access-tunnel-name"');
    expect(html).toContain('data-testid="remote-access-hostname-confirm"');
    expect(html).toContain('data-testid="remote-access-create-pending"');
    expect(html).not.toContain('data-testid="remote-access-create-submit"');
  });

  test('主机名非法时不让进入下一步', () => {
    status = tunnel({ auth: { loggedIn: true, loginUrl: null } });
    const invalid = renderWizard('named', { draft: namedDraft({ hostname: 'example' }) });
    expect(isDisabled(invalid, 'remote-access-hostname-confirm')).toBe(true);
    expect(invalid).toContain('settings.remoteAccess.steps.named.hostnameInvalid');

    const valid = renderWizard('named', {
      draft: namedDraft({ hostname: 'tmex.example.com' }),
    });
    expect(isDisabled(valid, 'remote-access-hostname-confirm')).toBe(false);
  });

  test('隧道名称非法时同样挡住下一步', () => {
    status = tunnel({ auth: { loggedIn: true, loginUrl: null } });
    const html = renderWizard('named', {
      draft: namedDraft({ hostname: 'tmex.example.com', tunnelName: '../../pkg' }),
    });
    expect(html).toContain('settings.remoteAccess.steps.named.tunnelNameInvalid');
    expect(isDisabled(html, 'remote-access-hostname-confirm')).toBe(true);
  });

  test('确认主机名后创建步才出现「创建并启动」', () => {
    status = tunnel({ auth: { loggedIn: true, loginUrl: null } });
    const html = renderWizard('named', {
      draft: namedDraft({ hostname: 'tmex.example.com', confirmed: true }),
    });
    expect(html).toContain('data-testid="remote-access-hostname-confirmed"');
    expect(html).toContain('data-testid="remote-access-hostname-edit"');
    expect(html).toContain('data-testid="remote-access-create-submit"');
    expect(html).not.toContain('data-testid="remote-access-create-pending"');
  });

  test('创建 job 在跑时展示 DNS 配置进度', () => {
    status = tunnel({
      auth: { loggedIn: true, loginUrl: null },
      job: job({ kind: 'create', state: 'running', step: 'route_dns' }),
    });
    const html = renderWizard('named', {
      draft: namedDraft({ hostname: 'tmex.example.com', confirmed: true }),
    });
    expect(html).toContain('data-testid="remote-access-create-progress"');
    expect(html).toContain('settings.remoteAccess.jobStep.route_dns');
  });

  test('创建失败时映射 DNS 错误码', () => {
    status = tunnel({
      auth: { loggedIn: true, loginUrl: null },
      job: job({
        kind: 'create',
        state: 'error',
        error: { code: 'dns_route_failed', message: 'no zone' },
      }),
    });
    const html = renderWizard('named', {
      draft: namedDraft({ hostname: 'tmex.example.com', confirmed: true }),
    });
    expect(html).toContain('settings.remoteAccess.errors.dns_route_failed');
  });

  test('已配置命名隧道时主机名步只读，没有创建表单', () => {
    status = configured('named', 'running', {
      auth: { loggedIn: true, loginUrl: null },
    });
    status.config.tunnelName = 'tmex';
    status.config.tunnelId = 'd8e1f0aa-0000-4000-8000-000000000000';
    const html = render();
    expect(html).toContain('data-testid="remote-access-named-summary"');
    expect(html).toContain('tmex.example.com');
    expect(html).toContain('d8e1f0aa-0000-4000-8000-000000000000');
    expect(html).not.toContain('data-testid="remote-access-create-submit"');
    expect(html).not.toContain('data-testid="remote-access-hostname"');
  });

  test('本机即 hub 时在主机名步骤给出 Hub 公开地址提示', () => {
    status = configured('named', 'stopped', { auth: { loggedIn: true, loginUrl: null } });

    setMeshNodesStateForTest({ modeLoaded: true, entryNodeId: SELF_ID, mode: authMode(OTHER_ID) });
    expect(render()).not.toContain('data-testid="remote-access-hub-hint"');

    setMeshNodesStateForTest({ modeLoaded: true, entryNodeId: SELF_ID, mode: authMode(SELF_ID) });
    const html = render();
    expect(html).toContain('data-testid="remote-access-hub-hint"');
    expect(html).toContain('?tab=nodes');
  });
});

describe('直接连接', () => {
  const localAuth = (overrides: Partial<LocalAuthStatus> = {}): LocalAuthStatus => ({
    supported: true,
    enabled: false,
    effective: false,
    credentialsPresent: false,
    ...overrides,
  });

  test('直接连接是顶层选项，且不因为没装 cloudflared 就锁死', () => {
    status = tunnel({ binary: { installed: false, version: null, path: null, source: null } });
    const html = render();
    expect(html).toContain('data-testid="remote-access-path-direct"');
    expect(html).toContain('settings.remoteAccess.path.direct.description');
    expect(isDisabled(html, 'remote-access-path-direct-input')).toBe(false);
  });

  test('已建隧道时直接连接卡锁定：换路径要先移除隧道', () => {
    status = configured('named', 'running');
    expect(isDisabled(render(), 'remote-access-path-direct-input')).toBe(true);
  });

  test('选中后只剩连接方式与访问保护两步，安装步不出现', () => {
    const html = renderWizard('direct', { localAuth: localAuth() });
    expect(stepOrder(html)).toEqual(['path', 'direct']);
    expect(html).not.toContain('data-testid="remote-access-step-install"');
  });

  test('hub / node 角色：已由节点登录保护，不再劝启用本机登录', () => {
    const html = renderWizard('direct', { localAuth: localAuth({ supported: false }) });
    expect(html).toContain('data-testid="remote-access-direct-node"');
    expect(html).toContain('settings.remoteAccess.direct.protection.node.title');
    expect(html).toContain('data-testid="remote-access-direct-entry"');
    expect(html).not.toContain('data-testid="remote-access-direct-enable"');
  });

  test('本机登录已生效：受保护态，同样不给启用表单', () => {
    const html = renderWizard('direct', {
      localAuth: localAuth({ enabled: true, effective: true, credentialsPresent: true }),
    });
    expect(html).toContain('data-testid="remote-access-direct-local"');
    expect(html).toContain('settings.remoteAccess.direct.protection.local.title');
    expect(html).not.toContain('data-testid="remote-access-direct-enable"');
  });

  test('未受保护：警示 + 建首位用户表单 + 二次确认，勾选前不让提交', () => {
    const html = renderWizard('direct', { localAuth: localAuth() });
    expect(html).toContain('data-testid="remote-access-direct-unprotected"');
    expect(html).toContain('settings.remoteAccess.direct.protection.unprotected.description');
    expect(html).toContain('data-stage="bootstrap"');
    expect(html).toContain('data-testid="remote-access-direct-username"');
    expect(html).toContain('data-testid="remote-access-direct-password"');
    expect(html).toContain('data-testid="remote-access-direct-confirm"');
    // 启用前必须先看到「所有已打开的会话都要重新登录」，并显式勾选。
    expect(html).toContain('data-testid="remote-access-direct-enable-warning"');
    expect(html).toContain('settings.remoteAccess.direct.enable.warning');
    expect(html).toContain('data-testid="remote-access-direct-ack"');
    expect(isDisabled(html, 'remote-access-direct-enable-submit')).toBe(true);
  });

  test('已有账号时跳过建用户，只留开关', () => {
    const html = renderWizard('direct', { localAuth: localAuth({ credentialsPresent: true }) });
    expect(html).toContain('data-stage="enable"');
    expect(html).not.toContain('data-testid="remote-access-direct-username"');
    expect(html).toContain('data-testid="remote-access-direct-enable-submit"');
  });

  test('后端没下发 localAuth 时按未知处理，绝不报成「没有保护」', () => {
    const html = renderWizard('direct');
    expect(html).toContain('data-testid="remote-access-direct-unknown"');
    expect(html).not.toContain('data-testid="remote-access-direct-unprotected"');
    expect(html).not.toContain('data-testid="remote-access-direct-enable"');
  });

  test('三档保护态都带上 HTTPS 提示与「只保证需要登录」的说明', () => {
    for (const auth of [
      localAuth({ supported: false }),
      localAuth({ enabled: true, effective: true, credentialsPresent: true }),
      localAuth(),
    ]) {
      const html = renderWizard('direct', { localAuth: auth });
      expect(html).toContain('settings.remoteAccess.direct.tls.hint');
      expect(html).toContain('settings.remoteAccess.direct.tls.link');
      expect(html).toContain('data-testid="remote-access-direct-caveat"');
    }
  });

  test('这条路径不发任何隧道动作：安装 / 启动 / 创建按钮一个都不出现', () => {
    const html = renderWizard('direct', { localAuth: localAuth() });
    expect(html).not.toContain('data-testid="remote-access-install"');
    expect(html).not.toContain('data-testid="remote-access-quick-start"');
    expect(html).not.toContain('data-testid="remote-access-create"');
    expect(html).not.toContain('data-testid="remote-access-trust-proxy"');
  });
});

describe('访问控制三选一', () => {
  const auth = { loggedIn: true, loginUrl: null };
  const localAuth = (overrides: Partial<LocalAuthStatus> = {}): LocalAuthStatus => ({
    supported: true,
    enabled: false,
    effective: false,
    credentialsPresent: false,
    ...overrides,
  });
  const withMode = (base: TunnelStatusResponse, accessMode: TunnelAccessMode) => ({
    ...base,
    config: { ...base.config, accessMode },
  });
  /** 访问控制排在主机名之后：隧道还没建时要先确认主机名，这一步才轮得到。 */
  const confirmedDraft = () => namedDraft({ hostname: 'tmex.example.com', confirmed: true });

  /** 选中态只看单选卡自身的 `data-selected`。 */
  function isSelected(html: string, testId: string): boolean {
    const tag = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html);
    if (!tag) throw new Error(`missing element: ${testId}`);
    return tag[0].includes('data-selected="true"');
  }

  test('三张单选卡常驻，还没选过时只给提示，不展开任何配置', () => {
    status = tunnel({ auth, loginEnforced: false });
    const html = renderWizard('named', { draft: confirmedDraft() });
    expect(html).toContain('data-testid="remote-access-access-mode-chooser"');
    expect(html).toContain('data-testid="remote-access-access-mode-none"');
    expect(html).toContain('data-testid="remote-access-access-mode-login"');
    expect(html).toContain('data-testid="remote-access-access-mode-cloudflare"');
    expect(html).toContain('settings.remoteAccess.accessMode.none.description');
    expect(html).toContain('data-testid="remote-access-access-mode-hint"');
    expect(html).not.toContain('data-testid="remote-access-access-cloudflare"');
    expect(html).not.toContain('data-testid="remote-access-access-login"');
    expect(html).not.toContain('data-testid="remote-access-access-none"');
    expect(stepStateOf(html, 'remote-access-step-access')).toBe('current');
  });

  test('选定的方式落在单选卡的选中态上；没选过时三张都不选中', () => {
    status = tunnel({ auth, loginEnforced: false });
    const undecided = renderWizard('named');
    expect(isSelected(undecided, 'remote-access-access-mode-none')).toBe(false);
    expect(isSelected(undecided, 'remote-access-access-mode-login')).toBe(false);

    status = withMode(tunnel({ auth, loginEnforced: false }), 'cloudflare');
    const chosen = renderWizard('named');
    expect(isSelected(chosen, 'remote-access-access-mode-cloudflare')).toBe(true);
    expect(isSelected(chosen, 'remote-access-access-mode-none')).toBe(false);
  });

  test('账号密码：登录门状态就地展示，没有门时给启用表单', () => {
    status = withMode(tunnel({ auth, loginEnforced: false }), 'login');
    const html = renderWizard('named', { draft: confirmedDraft(), localAuth: localAuth() });
    expect(html).toContain('data-testid="remote-access-access-login"');
    expect(html).toContain('data-testid="remote-access-direct-unprotected"');
    expect(html).toContain('data-testid="remote-access-direct-enable"');
    expect(html).toContain('data-testid="remote-access-direct-username"');
    // 这一档不碰 Cloudflare Access。
    expect(html).not.toContain('data-testid="remote-access-access-cloudflare"');
    expect(stepStateOf(html, 'remote-access-step-access')).toBe('current');
  });

  test('账号密码：门已生效时只留状态条，且这一步打勾', () => {
    status = withMode(tunnel({ auth, loginEnforced: true }), 'login');
    const html = renderWizard('named', {
      draft: confirmedDraft(),
      localAuth: localAuth({ enabled: true, effective: true, credentialsPresent: true }),
    });
    expect(html).toContain('data-testid="remote-access-direct-local"');
    expect(html).not.toContain('data-testid="remote-access-direct-enable"');
    expect(stepStateOf(html, 'remote-access-step-access')).toBe('done');
  });

  test('未选过但本机已有登录门时推导成账号密码，不再默认展开 Access', () => {
    status = tunnel({ auth, loginEnforced: true });
    const html = renderWizard('named');
    expect(isSelected(html, 'remote-access-access-mode-login')).toBe(true);
    expect(html).not.toContain('data-testid="remote-access-access-cloudflare"');
  });

  test('无：只给警示，Access 应用还在时就地给移除入口', () => {
    status = withMode(tunnel({ auth, loginEnforced: false }), 'none');
    const plain = renderWizard('named', { draft: confirmedDraft() });
    expect(plain).toContain('data-testid="remote-access-access-none-warning"');
    expect(plain).toContain('settings.remoteAccess.accessMode.none.warning');
    expect(plain).not.toContain('data-testid="remote-access-access-none-app"');
    expect(plain).not.toContain('data-testid="remote-access-access-cloudflare"');
    expect(stepStateOf(plain, 'remote-access-step-access')).toBe('done');

    const app = {
      ...tunnel().access,
      hasCredentials: true,
      configured: true,
      enforceJwt: true,
      hostname: 'tmex.example.com',
      effective: true,
    };
    status = withMode(
      configured('named', 'running', { auth, loginEnforced: false, access: app }),
      'none'
    );
    const withApp = renderWizard('named');
    expect(withApp).toContain('data-testid="remote-access-access-none-app"');
    expect(withApp).toContain('data-testid="remote-access-access-remove"');

    // 应用没生效（绑的是别的主机名）也要给移除入口：残留在 Cloudflare 上一样该清掉。
    status = withMode(
      configured('named', 'running', {
        auth,
        loginEnforced: false,
        access: { ...app, hostname: 'old.example.com', effective: false },
      }),
      'none'
    );
    const ineffective = renderWizard('named');
    expect(ineffective).toContain('data-testid="remote-access-access-none-app"');
    expect(ineffective).toContain('data-testid="remote-access-access-remove"');
  });

  test('隧道在跑又没有任何保护时，选「无」必须先勾确认', () => {
    status = withMode(
      configured('named', 'running', { auth, loginEnforced: false, exposureProtected: false }),
      'cloudflare'
    );
    const blocked = renderWizard('named');
    expect(blocked).toContain('data-testid="remote-access-access-mode-exposure"');
    expect(isDisabled(blocked, 'remote-access-access-mode-none-input')).toBe(true);
    // 另外两档是收敛动作，任何时候都能选。
    expect(isDisabled(blocked, 'remote-access-access-mode-login-input')).toBe(false);

    // 勾在别处的确认不算数：只有这条警示自己被勾上才放行。
    const other = renderWizard('named', { exposure: { ackedId: EXPOSURE_ACK.start } });
    expect(isDisabled(other, 'remote-access-access-mode-none-input')).toBe(true);

    const acknowledged = renderWizard('named', { exposure: { ackedId: EXPOSURE_ACK.accessMode } });
    expect(isDisabled(acknowledged, 'remote-access-access-mode-none-input')).toBe(false);
  });

  test('隧道没跑起来时不拦：选「无」直接可点', () => {
    status = withMode(tunnel({ auth, loginEnforced: false, exposureProtected: false }), 'login');
    const html = renderWizard('named');
    expect(html).not.toContain('data-testid="remote-access-access-mode-exposure"');
    expect(isDisabled(html, 'remote-access-access-mode-none-input')).toBe(false);
  });

  test('本地判定说没跑起来但后端回了 409：被拒的「无」照样给出勾选', () => {
    status = withMode(tunnel({ auth, loginEnforced: false, exposureProtected: false }), 'login');
    const rejected = renderWizard('named', {
      exposure: { ackRequired: true, ackRequiredId: EXPOSURE_ACK.accessMode },
    });
    expect(rejected).toContain('data-testid="remote-access-access-mode-exposure"');
    expect(rejected).toContain('data-testid="remote-access-access-mode-exposure-ack"');
    expect(rejected).toContain(`id="${EXPOSURE_ACK.accessMode}"`);
    expect(isDisabled(rejected, 'remote-access-access-mode-none-input')).toBe(true);

    // 归属只认被拒的那个动作：别处被拒不会把这条警示带出来。
    const elsewhere = renderWizard('named', {
      exposure: { ackRequired: true, ackRequiredId: EXPOSURE_ACK.start },
    });
    expect(elsewhere).not.toContain('data-testid="remote-access-access-mode-exposure"');

    // 勾上之后放行：重试由 `exposureAck.submit` 带上 acknowledgeExposure。
    const acknowledged = renderWizard('named', {
      exposure: {
        ackRequired: true,
        ackRequiredId: EXPOSURE_ACK.accessMode,
        ackedId: EXPOSURE_ACK.accessMode,
      },
    });
    expect(isDisabled(acknowledged, 'remote-access-access-mode-none-input')).toBe(false);
  });

  test('忙锁：动作进行中时三张卡都点不动', () => {
    status = tunnel({ auth, loginEnforced: false });
    const html = renderWizard('named', {
      actions: { ...IDLE_ACTIONS, pending: 'set_access_mode', busy: true },
    });
    expect(isDisabled(html, 'remote-access-access-mode-none-input')).toBe(true);
    expect(isDisabled(html, 'remote-access-access-mode-cloudflare-input')).toBe(true);
  });

  test('状态卡徽标报实际保护状态，不是用户选了什么', () => {
    const effectiveAccess = {
      ...tunnel().access,
      hasCredentials: true,
      configured: true,
      enforceJwt: true,
      hostname: 'tmex.example.com',
      effective: true,
    };

    status = withMode(configured('named', 'running', { loginEnforced: true }), 'login');
    expect(renderStatusCard()).toContain('settings.remoteAccess.accessState.loginProtected');

    // 选了「无」但 Access 校验仍在生效：照实报「已生效」，不能按选择谎报没有保护。
    status = withMode(
      configured('named', 'running', { loginEnforced: false, access: effectiveAccess }),
      'none'
    );
    expect(renderStatusCard()).toContain('settings.remoteAccess.accessState.protected');

    status = withMode(configured('named', 'running', { loginEnforced: false }), 'login');
    expect(renderStatusCard()).toContain('settings.remoteAccess.accessState.loginMissing');

    // 选了 Access 但应用还没建起来：沿用 Access 的诊断徽标。
    status = withMode(configured('named', 'running', { loginEnforced: false }), 'cloudflare');
    expect(renderStatusCard()).toContain('settings.remoteAccess.accessState.unknown');
    status = withMode(
      configured('named', 'running', {
        loginEnforced: false,
        access: { ...effectiveAccess, enforceJwt: false, effective: false },
      }),
      'cloudflare'
    );
    expect(renderStatusCard()).toContain('settings.remoteAccess.accessState.notEnforced');

    status = withMode(configured('named', 'running', { loginEnforced: false }), 'none');
    expect(renderStatusCard()).toContain('settings.remoteAccess.accessState.unprotected');
  });
});

describe('Cloudflare Access 区块', () => {
  const loggedIn = (overrides: Partial<TunnelStatusResponse> = {}) =>
    withCloudflareAccess(
      configured('named', 'running', { auth: { loggedIn: true, loginUrl: null }, ...overrides })
    );

  test('未保存凭证时给令牌与账户 ID 表单，且没有规则编辑器', () => {
    status = loggedIn();
    const html = render();
    expect(html).toContain('data-testid="remote-access-access-credentials"');
    expect(html).toContain('data-testid="remote-access-access-token"');
    expect(html).toContain('data-testid="remote-access-access-account"');
    expect(html).toContain('settings.remoteAccess.access.credentials.apiTokenHint');
    // 令牌不能明文回显。
    expect(html).toContain('type="password"');
    expect(html).not.toContain('data-testid="remote-access-access-rules"');
    // 两个字段都空时保存按钮不可点。
    expect(isDisabled(html, 'remote-access-access-save-credentials')).toBe(true);
  });

  test('已保存凭证时只展示账户 ID、团队域与清除按钮', () => {
    status = loggedIn({
      access: {
        ...tunnel().access,
        hasCredentials: true,
        accountId: 'acc-123',
        teamDomain: 'tmex.cloudflareaccess.com',
      },
    });
    const html = render();
    expect(html).toContain('data-testid="remote-access-access-credentials-saved"');
    expect(html).toContain('acc-123');
    expect(html).toContain('tmex.cloudflareaccess.com');
    expect(html).toContain('data-testid="remote-access-access-clear-credentials"');
    expect(html).not.toContain('data-testid="remote-access-access-token"');
  });

  test('凭证已保存时不再常驻成功条——成功提示改成一次性 toast', () => {
    status = loggedIn({
      access: { ...tunnel().access, hasCredentials: true, accountId: 'acc-123' },
    });
    const html = render();
    expect(html).toContain('data-testid="remote-access-access-credentials-saved"');
    expect(html).not.toContain('settings.remoteAccess.access.credentials.saved');
  });

  test('凭证已保存但没有应用时提示先同步，并给出同步与应用两个按钮', () => {
    status = loggedIn({ access: { ...tunnel().access, hasCredentials: true } });
    const html = render();
    expect(html).toContain('data-testid="remote-access-access-rules"');
    expect(html).toContain('data-testid="remote-access-access-sync-hint"');
    expect(html).toContain('data-testid="remote-access-access-sync"');
    expect(html).toContain('data-testid="remote-access-access-apply"');
    // 默认一条空规则：不合法，应用按钮禁用；也不给删除按钮（至少留一条）。
    expect(html).toContain('data-testid="remote-access-access-rule-0-value"');
    expect(isDisabled(html, 'remote-access-access-apply')).toBe(true);
    expect(html).not.toContain('data-testid="remote-access-access-rule-0-remove"');
  });

  test('服务端已有规则时回填草稿，应用按钮可用，且能删除多余规则', () => {
    status = loggedIn({
      access: {
        ...tunnel().access,
        hasCredentials: true,
        rules: [
          { kind: 'email', value: 'you@example.com' },
          { kind: 'email_domain', value: 'example.com' },
        ],
      },
    });
    const html = render();
    expect(html).toContain('you@example.com');
    expect(html).toContain('example.com');
    expect(isDisabled(html, 'remote-access-access-apply')).toBe(false);
    expect(html).toContain('data-testid="remote-access-access-rule-0-remove"');
    expect(html).toContain('data-testid="remote-access-access-rule-1-remove"');
  });

  test('非法规则值就地报错', () => {
    status = loggedIn({
      access: {
        ...tunnel().access,
        hasCredentials: true,
        rules: [{ kind: 'email', value: 'not-an-email' }],
      },
    });
    const html = render();
    expect(html).toContain('data-testid="remote-access-access-rule-0-error"');
    expect(html).toContain('settings.remoteAccess.access.rules.invalid.email');
    expect(isDisabled(html, 'remote-access-access-apply')).toBe(true);
  });

  test('还没有主机名时同步与应用都不可用，并说明原因', () => {
    status = withCloudflareAccess(
      tunnel({
        auth: { loggedIn: true, loginUrl: null },
        access: { ...tunnel().access, hasCredentials: true },
      })
    );
    const html = renderWizard('named');
    expect(html).toContain('data-testid="remote-access-access-no-hostname"');
    expect(isDisabled(html, 'remote-access-access-sync')).toBe(true);
    expect(isDisabled(html, 'remote-access-access-apply')).toBe(true);
    expect(html).not.toContain('data-testid="remote-access-access-sync-hint"');
  });

  test('隧道还没建但向导已确认主机名时可以先配 Access（同步仍不可用）', () => {
    status = withCloudflareAccess(
      tunnel({
        auth: { loggedIn: true, loginUrl: null },
        access: {
          ...tunnel().access,
          hasCredentials: true,
          rules: [{ kind: 'email', value: 'you@example.com' }],
        },
      })
    );
    const html = renderWizard('named', {
      draft: namedDraft({ hostname: 'draft.example.com', confirmed: true }),
    });
    expect(html).not.toContain('data-testid="remote-access-access-no-hostname"');
    expect(isDisabled(html, 'remote-access-access-apply')).toBe(false);
    // 同步只认 config.hostname 与探测到的系统隧道主机名。
    expect(isDisabled(html, 'remote-access-access-sync')).toBe(true);
  });

  test('access job 在跑时展示创建应用与配置策略的进度', () => {
    status = loggedIn({
      access: { ...tunnel().access, hasCredentials: true },
      job: job({ kind: 'access', state: 'running', step: 'create_app' }),
    });
    expect(render()).toContain('settings.remoteAccess.jobStep.create_app');

    status = loggedIn({
      access: { ...tunnel().access, hasCredentials: true },
      job: job({ kind: 'access', state: 'running', step: 'policy' }),
    });
    const html = render();
    expect(html).toContain('data-testid="remote-access-access-progress"');
    expect(html).toContain('settings.remoteAccess.jobStep.policy');
  });

  test('应用已建好时展示应用 ID / AUD / 覆盖主机名 / 规则与强制开关', () => {
    status = loggedIn({
      access: {
        ...tunnel().access,
        hasCredentials: true,
        configured: true,
        appId: 'app-1',
        aud: 'aud-hash',
        hostname: 'tmex.example.com',
        rules: [{ kind: 'email', value: 'you@example.com' }],
      },
    });
    const html = render();
    expect(html).toContain('data-testid="remote-access-access-app"');
    expect(html).toContain('app-1');
    expect(html).toContain('aud-hash');
    expect(html).toContain('data-testid="remote-access-access-app-hostname"');
    expect(html).toContain('data-testid="remote-access-access-app-rules"');
    expect(isChecked(html, 'remote-access-access-enforce')).toBe(true);
    expect(html).not.toContain('data-testid="remote-access-access-enforce-off"');
    expect(html).toContain('data-testid="remote-access-access-remove"');
    // 静态渲染点不了按钮，删除应用的确认框默认不在 DOM 里。
    expect(html).not.toContain('data-testid="remote-access-access-confirm-remove"');
  });

  test('关闭令牌校验时给出明确警告', () => {
    status = loggedIn({
      access: {
        ...tunnel().access,
        hasCredentials: true,
        configured: true,
        enforceJwt: false,
        rules: [{ kind: 'email', value: 'you@example.com' }],
      },
    });
    const html = render();
    expect(isChecked(html, 'remote-access-access-enforce')).toBe(false);
    expect(html).toContain('data-testid="remote-access-access-enforce-off"');
    expect(html).toContain('settings.remoteAccess.access.app.enforceOff');
  });

  test('应用绑的主机名与当前隧道不一致时就地说明校验不会生效', () => {
    status = loggedIn({
      access: {
        ...tunnel().access,
        hasCredentials: true,
        configured: true,
        enforceJwt: true,
        hostname: 'old.example.com',
        effective: false,
        rules: [{ kind: 'email', value: 'you@example.com' }],
      },
    });
    const html = render();
    expect(html).toContain('data-testid="remote-access-access-hostname-mismatch"');
    expect(html).toContain('settings.remoteAccess.access.app.hostnameMismatch');

    // 隧道还没建时不该报「不匹配」：向导允许先按草稿主机名把 Access 配好。
    status = withCloudflareAccess(
      tunnel({
        auth: { loggedIn: true, loginUrl: null },
        access: {
          ...tunnel().access,
          hasCredentials: true,
          configured: true,
          enforceJwt: true,
          hostname: 'draft.example.com',
          effective: false,
          rules: [{ kind: 'email', value: 'you@example.com' }],
        },
      })
    );
    expect(renderWizard('named')).not.toContain(
      'data-testid="remote-access-access-hostname-mismatch"'
    );
  });

  test('拿掉最后一道保护前必须先勾确认：警示在场且强制开关锁住', () => {
    const lastProtection = {
      ...tunnel().access,
      hasCredentials: true,
      configured: true,
      enforceJwt: true,
      hostname: 'tmex.example.com',
      effective: true,
      rules: [{ kind: 'email' as const, value: 'you@example.com' }],
    };
    status = loggedIn({ access: lastProtection, loginEnforced: false, exposureProtected: true });
    const html = renderWizard('named');
    expect(html).toContain('data-testid="remote-access-access-drop-exposure"');
    expect(html).toContain('settings.remoteAccess.exposure.dropWarning');
    expect(html).toContain('data-testid="remote-access-access-drop-exposure-ack"');
    expect(isSwitchDisabled(html, 'remote-access-access-enforce')).toBe(true);

    const other = renderWizard('named', { exposure: { ackedId: EXPOSURE_ACK.accessRemove } });
    expect(isSwitchDisabled(other, 'remote-access-access-enforce')).toBe(true);

    const acknowledged = renderWizard('named', {
      exposure: { ackedId: EXPOSURE_ACK.accessEnforce },
    });
    expect(isSwitchDisabled(acknowledged, 'remote-access-access-enforce')).toBe(false);
  });

  test('还有登录兜底 / 隧道没跑起来时不拦截关闭校验', () => {
    const access = {
      ...tunnel().access,
      hasCredentials: true,
      configured: true,
      enforceJwt: true,
      hostname: 'tmex.example.com',
      effective: true,
      rules: [{ kind: 'email' as const, value: 'you@example.com' }],
    };
    status = loggedIn({ access, loginEnforced: true });
    const withLogin = renderWizard('named');
    expect(withLogin).not.toContain('data-testid="remote-access-access-drop-exposure"');
    expect(isSwitchDisabled(withLogin, 'remote-access-access-enforce')).toBe(false);

    status = configured('named', 'stopped', {
      auth: { loggedIn: true, loginUrl: null },
      access,
      loginEnforced: false,
    });
    const stopped = renderWizard('named');
    expect(stopped).not.toContain('data-testid="remote-access-access-drop-exposure"');
    expect(isSwitchDisabled(stopped, 'remote-access-access-enforce')).toBe(false);
  });

  test('Access 没生效也要确认：主机名不匹配、隧道在跑又没有登录时勾选提前摆出来', () => {
    const mismatched = {
      ...tunnel().access,
      hasCredentials: true,
      configured: true,
      enforceJwt: true,
      hostname: 'old.example.com',
      effective: false,
      rules: [{ kind: 'email' as const, value: 'you@example.com' }],
    };
    status = loggedIn({ access: mismatched, loginEnforced: false, exposureProtected: false });
    const html = renderWizard('named');
    expect(html).toContain('data-testid="remote-access-access-drop-exposure"');
    expect(html).toContain('data-testid="remote-access-access-drop-exposure-ack"');
    expect(isSwitchDisabled(html, 'remote-access-access-enforce')).toBe(true);
    expect(html).toContain('data-testid="remote-access-access-remove"');

    const acknowledged = renderWizard('named', {
      exposure: { ackedId: EXPOSURE_ACK.accessEnforce },
    });
    expect(isSwitchDisabled(acknowledged, 'remote-access-access-enforce')).toBe(false);
  });

  test('关闭校验被 409 拒掉：隧道看着已停也要把勾选亮出来', () => {
    const access = {
      ...tunnel().access,
      hasCredentials: true,
      configured: true,
      enforceJwt: true,
      hostname: 'tmex.example.com',
      effective: true,
      rules: [{ kind: 'email' as const, value: 'you@example.com' }],
    };
    status = configured('named', 'stopped', {
      auth: { loggedIn: true, loginUrl: null },
      access,
      loginEnforced: false,
    });
    expect(renderWizard('named')).not.toContain('data-testid="remote-access-access-drop-exposure"');

    const rejected = renderWizard('named', {
      exposure: { ackRequired: true, ackRequiredId: EXPOSURE_ACK.accessEnforce },
    });
    expect(rejected).toContain('data-testid="remote-access-access-drop-exposure"');
    expect(rejected).toContain('data-testid="remote-access-access-drop-exposure-ack"');
    expect(isSwitchDisabled(rejected, 'remote-access-access-enforce')).toBe(true);
    // 移除按钮那条属于另一个动作，不跟着亮。
    expect(rejected).not.toContain('data-testid="remote-access-access-remove-exposure"');
  });

  test('移除 Access 被 409 拒掉：确认框从对话框里挪到按钮旁边', () => {
    const access = {
      ...tunnel().access,
      hasCredentials: true,
      configured: true,
      enforceJwt: true,
      hostname: 'tmex.example.com',
      effective: true,
      rules: [{ kind: 'email' as const, value: 'you@example.com' }],
    };
    status = configured('named', 'stopped', {
      auth: { loggedIn: true, loginUrl: null },
      access,
      loginEnforced: false,
    });
    // 对话框没打开，平时按钮旁不重复挂一条警示。
    expect(renderWizard('named')).not.toContain(
      'data-testid="remote-access-access-remove-exposure"'
    );

    const rejected = renderWizard('named', {
      exposure: { ackRequired: true, ackRequiredId: EXPOSURE_ACK.accessRemove },
    });
    expect(rejected).toContain('data-testid="remote-access-access-remove-exposure"');
    expect(rejected).toContain('data-testid="remote-access-access-remove-exposure-ack"');
    expect(rejected).toContain(`id="${EXPOSURE_ACK.accessRemove}"`);
    expect(rejected).not.toContain('data-testid="remote-access-access-drop-exposure"');
  });

  test('Access 最近一次错误就地展示', () => {
    status = loggedIn({
      access: { ...tunnel().access, hasCredentials: true, lastError: 'token expired' },
    });
    const html = render();
    expect(html).toContain('data-testid="remote-access-access-last-error"');
    expect(html).toContain('settings.remoteAccess.access.lastError');
  });
});

describe('未启用登录时的兼容提醒', () => {
  test('后端仍回 auth_required 时给出旧提示并链到多节点设置', () => {
    status = tunnel({
      auth: { loggedIn: true, loginUrl: null },
      job: job({
        kind: 'create',
        state: 'error',
        error: { code: 'auth_required', message: 'sign-in disabled' },
      }),
    });
    const html = renderWizard('named', {
      actions: { ...IDLE_ACTIONS, error: { code: 'auth_required', message: 'sign-in disabled' } },
    });
    expect(html).toContain('data-testid="remote-access-auth-required"');
    expect(html).toContain('settings.remoteAccess.authRequired.notice');
    expect(html).toContain('?tab=nodes');
  });

  test('没有相关错误时不打扰', () => {
    status = tunnel({ auth: { loggedIn: true, loginUrl: null } });
    expect(renderWizard('named')).not.toContain('data-testid="remote-access-auth-required"');
  });
});

describe('日志', () => {
  test('有输出时渲染日志框，无输出时给空提示', () => {
    status = tunnel({ log: ['2026-08-30 INF Registered tunnel connection'] });
    const html = renderStatusCard();
    expect(html).toContain('data-testid="remote-access-log-box"');
    expect(html).toContain('Registered tunnel connection');

    status = tunnel();
    const empty = renderStatusCard();
    expect(empty).toContain('data-testid="remote-access-log-empty"');
    expect(empty).toContain('settings.remoteAccess.log.empty');
  });

  test('外部 cloudflared 没有日志时说清原因，而不是「暂无输出」', () => {
    status = configured('named', 'stopped');
    status.config.externallyManaged = true;
    const html = renderStatusCard();
    expect(html).toContain('settings.remoteAccess.log.emptyExternal');
  });

  test('只渲染末尾 200 行', () => {
    status = tunnel({ log: Array.from({ length: 260 }, (_, i) => `line ${i}`) });
    const html = renderStatusCard();
    expect(html).not.toContain('line 59');
    expect(html).toContain('line 60');
    expect(html).toContain('line 259');
  });
});

function namedDraft(overrides: Partial<NamedDraft> = {}): NamedDraft {
  return {
    hostname: '',
    tunnelName: '',
    confirmed: false,
    setHostname: () => undefined,
    setTunnelName: () => undefined,
    setConfirmed: () => undefined,
    ...overrides,
  };
}

function exposureState(overrides: Partial<ExposureState> = {}): ExposureState {
  const current = status;
  return {
    unprotected: current ? !current.exposureProtected : false,
    ackRequired: false,
    ackRequiredId: null,
    ackedId: null,
    setAckedId: () => undefined,
    ...overrides,
  };
}

/**
 * 连接方式、隧道类型与主机名草稿都由标签层的 `useState` 驱动，静态渲染点不了控件——子步骤
 * 直接渲染 `TunnelWizard` 并把它们传进去；`RemoteAccessTab` 只负责把 state 接上这些入参。
 * `'off'` 表示「选了 Cloudflare Tunnel，但还没选类型」。
 */
function renderWizard(
  mode: TunnelMode | 'direct',
  options: {
    isHub?: boolean;
    draft?: NamedDraft;
    actions?: ActionSnapshot;
    exposure?: Partial<ExposureState>;
    localAuth?: LocalAuthStatus | null;
  } = {}
): string {
  const current = status;
  if (!current) throw new Error('status fixture is required');
  const snapshot = options.actions ?? actionState;
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/settings']}>
      <TunnelWizard
        status={current}
        actions={{ ...snapshot, run: () => undefined, clearError: () => undefined }}
        chosenPath={mode === 'direct' ? 'direct' : 'tunnel'}
        onChoosePath={() => undefined}
        chosenMode={mode === 'direct' || mode === 'off' ? null : mode}
        onChooseMode={() => undefined}
        draft={options.draft ?? namedDraft()}
        isHub={options.isHub ?? false}
        exposure={exposureState(options.exposure)}
        onRestarted={() => undefined}
        localAuth={options.localAuth ?? null}
        onLocalAuth={() => undefined}
      />
    </MemoryRouter>
  );
}

/** 状态卡只在选了隧道路径或已建过隧道时挂在标签上；未配置态的断言直接渲染卡片本体。 */
function renderStatusCard(): string {
  const current = status;
  if (!current) throw new Error('status fixture is required');
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/settings']}>
      <TunnelStatusCard
        status={current}
        actions={{ ...actionState, run: () => undefined, clearError: () => undefined }}
        exposure={exposureState()}
      />
    </MemoryRouter>
  );
}

function authMode(hubNodeId: string): AuthModeResponse {
  return {
    mode: 'mesh',
    nodeId: SELF_ID,
    uid: null,
    username: null,
    kdfParams: null,
    passkeysForThisOrigin: false,
    passkeyAvailable: false,
    hubNodeId,
  };
}
