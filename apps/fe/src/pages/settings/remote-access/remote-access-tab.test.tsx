// 「远程访问」标签的静态渲染：远端路由拦截、加载 / 未登录 / 失败分支、状态徽标矩阵、
// 向导步进（临时隧道与命名隧道两条路径）、登录授权地址与取消、错误码映射与忙锁。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 HttpsSection / SettingsPage 测试同一套做法）。

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import type {
  TunnelJobStatus,
  TunnelMode,
  TunnelProcessState,
  TunnelStatusResponse,
} from '@tmex/shared';
import { installWindowStorage } from '@tmex/stores/test-utils';
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
      originPort: 9883,
    },
    process: {
      state: 'stopped',
      pid: null,
      startedAt: null,
      publicUrl: null,
      lastError: null,
      restarts: 0,
    },
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
    const html = render();
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
    actionState = { ...IDLE_ACTIONS, checkJobId: 'check-1', check: { ok: true, message: null } };
    expect(render()).toContain('data-testid="remote-access-check-ok"');

    actionState = {
      ...IDLE_ACTIONS,
      checkJobId: 'check-1',
      check: { ok: false, message: '502 bad gateway' },
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

describe('错误码映射', () => {
  test('已知错误码走本地化文案', () => {
    actionState = {
      ...IDLE_ACTIONS,
      error: { code: 'busy', message: 'another action is running' },
    };
    const html = render();
    expect(html).toContain('data-testid="remote-access-error"');
    expect(html).toContain('settings.remoteAccess.errors.busy');
  });

  test('未知错误码退回带原始 message 的兜底文案', () => {
    actionState = { ...IDLE_ACTIONS, error: { code: 'unknown', message: 'network down' } };
    expect(render()).toContain('settings.remoteAccess.errors.unknown');
  });
});

describe('向导步进', () => {
  test('未安装 cloudflared 时停在第 1 步并给安装按钮', () => {
    status = tunnel({ binary: { installed: false, version: null, path: null, source: null } });
    const html = render();
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
    const html = render();
    expect(html).toContain('data-testid="remote-access-unsupported"');
    expect(html).not.toContain('data-testid="remote-access-install"');
  });

  test('安装 job 在跑时展示进度步骤', () => {
    status = tunnel({
      binary: { installed: false, version: null, path: null, source: null },
      job: job({ kind: 'install', state: 'running', step: 'download' }),
    });
    const html = render();
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
    expect(render()).toContain('settings.remoteAccess.errors.download_failed');
  });

  test('装好后停在第 2 步：两张方式卡都在，第 3 步等待选择', () => {
    const html = render();
    expect(stepStateOf(html, 'remote-access-step-install')).toBe('done');
    expect(stepStateOf(html, 'remote-access-step-mode')).toBe('current');
    expect(html).toContain('data-testid="remote-access-mode-quick"');
    expect(html).toContain('data-testid="remote-access-mode-named"');
    expect(html).toContain('data-testid="remote-access-step-tunnel-idle"');
    expect(html).toContain('data-testid="remote-access-binary"');
  });

  test('已建好隧道时方式卡锁定，向导停在第 4 步', () => {
    status = configured('named', 'running');
    const html = render();
    expect(stepStateOf(html, 'remote-access-step-tunnel')).toBe('done');
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

  test('登录后展示主机名与隧道名称表单', () => {
    status = tunnel({ auth: { loggedIn: true, loginUrl: null } });
    const html = renderWizard('named');
    expect(html).toContain('data-testid="remote-access-logged-in"');
    expect(html).toContain('data-testid="remote-access-hostname"');
    expect(html).toContain('data-testid="remote-access-tunnel-name"');
    expect(html).toContain('data-testid="remote-access-create-submit"');
  });

  test('创建 job 在跑时展示 DNS 配置进度', () => {
    status = tunnel({
      auth: { loggedIn: true, loginUrl: null },
      job: job({ kind: 'create', state: 'running', step: 'route_dns' }),
    });
    const html = renderWizard('named');
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
    expect(renderWizard('named')).toContain('settings.remoteAccess.errors.dns_route_failed');
  });

  test('已配置命名隧道时第 3 步只给只读摘要，没有创建表单', () => {
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

describe('未启用登录时的提醒', () => {
  test('/api/auth/mode 报 none 时在第 2 步之前给出提示并链到多节点设置', () => {
    const html = renderWizard('named', false, true);
    expect(html).toContain('data-testid="remote-access-auth-required"');
    expect(html).toContain('settings.remoteAccess.authRequired.notice');
    expect(html).toContain('?tab=nodes');
    expect(html.indexOf('data-testid="remote-access-auth-required"')).toBeLessThan(
      html.indexOf('data-testid="remote-access-step-mode"')
    );
  });

  test('后端回 auth_required 时同样常驻提示', () => {
    status = tunnel({
      auth: { loggedIn: true, loginUrl: null },
      job: job({
        kind: 'create',
        state: 'error',
        error: { code: 'auth_required', message: 'sign-in disabled' },
      }),
    });
    const html = renderWizard('named');
    expect(html).toContain('data-testid="remote-access-auth-required"');
    expect(html).toContain('settings.remoteAccess.errors.auth_required');
  });

  test('登录已启用且没有相关错误时不打扰', () => {
    expect(renderWizard('named')).not.toContain('data-testid="remote-access-auth-required"');
  });
});

describe('日志', () => {
  test('有输出时渲染日志框，无输出时给空提示', () => {
    status = tunnel({ log: ['2026-08-30 INF Registered tunnel connection'] });
    const html = render();
    expect(html).toContain('data-testid="remote-access-log-box"');
    expect(html).toContain('Registered tunnel connection');

    status = tunnel();
    expect(render()).toContain('data-testid="remote-access-log-empty"');
  });

  test('只渲染末尾 200 行', () => {
    status = tunnel({ log: Array.from({ length: 260 }, (_, i) => `line ${i}`) });
    const html = render();
    expect(html).not.toContain('line 59');
    expect(html).toContain('line 60');
    expect(html).toContain('line 259');
  });
});

/**
 * 第 3 步走哪条路径由本地选择驱动，静态渲染点不了方式卡——命名隧道的子步骤直接渲染
 * `TunnelWizard` 并把选择传进去；`RemoteAccessTab` 只负责把 `useState` 接上这个入参。
 */
function renderWizard(mode: TunnelMode, isHub = false, authDisabled = false): string {
  const current = status;
  if (!current) throw new Error('status fixture is required');
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/settings']}>
      <TunnelWizard
        status={current}
        actions={{ ...actionState, run: () => undefined, clearError: () => undefined }}
        chosenMode={mode}
        onChooseMode={() => undefined}
        isHub={isHub}
        authDisabled={authDisabled}
        onRestarted={() => undefined}
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
