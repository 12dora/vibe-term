// 远程访问的纯推导：状态徽标、向导步进、主机名校验、轮询节奏与错误 / 进度文案键。

import { describe, expect, test } from 'bun:test';
import { TunnelApiError } from '@tmex/api-client/local/tunnel-api';
import type { LocalAuthStatus, TunnelAccessMode, TunnelStatusResponse } from '@tmex/shared';
import {
  TUNNEL_ACTIVE_POLL_MS,
  TUNNEL_IDLE_POLL_MS,
  accessEffective,
  accessPill,
  checkNotice,
  connectorState,
  degradedError,
  describeTunnelError,
  effectiveMode,
  effectivePath,
  isAuthRequiredError,
  isExposingAction,
  isExposureAckError,
  isTunnelRunning,
  isValidHostname,
  isValidTunnelName,
  jobStepKey,
  logTail,
  protectionPill,
  toTunnelError,
  trustProxyRestartRequired,
  tunnelDegraded,
  tunnelErrorKey,
  tunnelExposed,
  tunnelPill,
  tunnelPollInterval,
  withExposureAck,
  wizardStepState,
  wizardSteps,
  wouldDropLastProtection,
} from './tunnel-model';

function status(overrides: Partial<TunnelStatusResponse> = {}): TunnelStatusResponse {
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

describe('tunnelPill', () => {
  test('未配置：mode 为 off 且进程没报错', () => {
    expect(tunnelPill(status())).toBe('notConfigured');
  });

  test('已配置后按进程状态映射', () => {
    const config = { ...status().config, mode: 'quick' as const };
    expect(tunnelPill(status({ config }))).toBe('stopped');
    expect(
      tunnelPill(status({ config, process: { ...status().process, state: 'starting' } }))
    ).toBe('starting');
    expect(tunnelPill(status({ config, process: { ...status().process, state: 'running' } }))).toBe(
      'running'
    );
  });

  test('接管来的隧道按探测到的运行态显示，不看 tmex 自己的进程', () => {
    const config = { ...status().config, mode: 'named' as const, externallyManaged: true };
    const external = { ...status().external, detected: true, running: true };
    expect(tunnelPill(status({ config, external }))).toBe('running');
    expect(tunnelPill(status({ config }))).toBe('stopped');
  });

  test('进程报错优先于「未配置」：移除失败后不能显示成一片干净', () => {
    expect(
      tunnelPill(
        status({ process: { ...status().process, state: 'error', lastError: 'exit code 1' } })
      )
    ).toBe('error');
  });
});

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

describe('connectorState', () => {
  test('有边缘连接才算在线', () => {
    expect(connectorState(status({ connector: connector() }))).toBe('connected');
    expect(connectorState(status({ connector: connector({ readyConnections: 0 }) }))).toBe(
      'noConnections'
    );
  });

  test('metrics 端点探不到只是「无法探测」：不能据此宣告零连接', () => {
    expect(
      connectorState(status({ connector: connector({ reachable: false, readyConnections: null }) }))
    ).toBe('unknown');
  });

  test('探过了但找不到端点是「未知」，从未探过是「未探测」', () => {
    expect(
      connectorState(status({ connector: connector({ reachable: null, readyConnections: null }) }))
    ).toBe('unknown');
    expect(
      connectorState(
        status({
          connector: connector({ reachable: null, readyConnections: null, checkedAt: null }),
        })
      )
    ).toBe('unprobed');
  });

  test('旧后端没有 connector 字段时按未探测处理，不能据此判无连接', () => {
    const legacy = status();
    const { connector: _connector, ...rest } = legacy;
    expect(connectorState(rest as TunnelStatusResponse)).toBe('unprobed');
  });

  test('端点应答但没给出连接数：只算「无法探测」，不宣告零连接', () => {
    expect(connectorState(status({ connector: connector({ readyConnections: null }) }))).toBe(
      'unknown'
    );
    expect(
      connectorState(
        status({ connector: connector({ readyConnections: undefined as unknown as number }) })
      )
    ).toBe('unknown');
    expect(connectorState(status({ connector: connector({ readyConnections: Number.NaN }) }))).toBe(
      'unknown'
    );
    expect(connectorState(status({ connector: connector({ readyConnections: -1 }) }))).toBe(
      'unknown'
    );
  });
});

describe('degradedError', () => {
  test('进程错误优先于连接器错误，都没有时为 null', () => {
    expect(degradedError(status())).toBeNull();
    expect(
      degradedError(
        status({
          process: { ...status().process, lastError: 'exit code 1' },
          connector: connector({ lastError: 'failed to dial edge' }),
        })
      )
    ).toBe('exit code 1');
    expect(
      degradedError(status({ connector: connector({ lastError: 'failed to dial edge' }) }))
    ).toBe('failed to dial edge');
  });

  test('空白错误当没有；超长错误截断并补省略号', () => {
    expect(
      degradedError(status({ process: { ...status().process, lastError: '   ' } }))
    ).toBeNull();
    const long = 'x'.repeat(400);
    const truncated = degradedError(status({ process: { ...status().process, lastError: long } }));
    expect(truncated).toBe(`${'x'.repeat(200)}…`);
  });
});

describe('tunnelDegraded / degraded 徽标', () => {
  const config = { mode: 'quick' as const };

  test('进程说自己 degraded 就是 degraded', () => {
    const degraded = status({
      config: { ...status().config, ...config },
      process: { ...status().process, state: 'degraded' },
    });
    expect(tunnelDegraded(degraded)).toBe(true);
    expect(tunnelPill(degraded)).toBe('degraded');
  });

  test('进程「运行中」但连接器零连接：同样是 degraded', () => {
    const zero = status({
      config: { ...status().config, ...config },
      process: { ...status().process, state: 'running' },
      connector: connector({ readyConnections: 0 }),
    });
    expect(tunnelDegraded(zero)).toBe(true);
    expect(tunnelPill(zero)).toBe('degraded');
  });

  test('连接器在线时仍是运行中；探不到连接器时不冤枉它', () => {
    const base = {
      config: { ...status().config, ...config },
      process: { ...status().process, state: 'running' as const },
    };
    expect(tunnelPill(status({ ...base, connector: connector() }))).toBe('running');
    expect(
      tunnelPill(
        status({ ...base, connector: connector({ reachable: null, readyConnections: null }) })
      )
    ).toBe('running');
    // metrics 端口被挡住（reachable=false）时隧道多半好好的，后端也仍报 running
    expect(
      tunnelPill(
        status({ ...base, connector: connector({ reachable: false, readyConnections: null }) })
      )
    ).toBe('running');
  });

  test('接管来的隧道：进程在跑但零连接也要降级', () => {
    const adoptedConfig = {
      ...status().config,
      mode: 'named' as const,
      externallyManaged: true,
    };
    const external = { ...status().external, detected: true, running: true };
    expect(tunnelPill(status({ config: adoptedConfig, external, connector: connector() }))).toBe(
      'running'
    );
    expect(
      tunnelPill(
        status({
          config: adoptedConfig,
          external,
          connector: connector({ readyConnections: 0 }),
        })
      )
    ).toBe('degraded');
    // 进程都没在跑就谈不上降级。
    expect(
      tunnelPill(status({ config: adoptedConfig, connector: connector({ readyConnections: 0 }) }))
    ).toBe('stopped');
  });

  test('停止 / 启动中不受连接器影响', () => {
    const base = { config: { ...status().config, ...config } };
    expect(tunnelPill(status({ ...base, connector: connector({ readyConnections: 0 }) }))).toBe(
      'stopped'
    );
    expect(
      tunnelPill(
        status({
          ...base,
          process: { ...status().process, state: 'starting' },
          connector: connector({ readyConnections: 0 }),
        })
      )
    ).toBe('starting');
  });

  test('degraded 时进程还在，拿掉最后一道保护同样危险', () => {
    const base = withAccess({}, { loginEnforced: false });
    const degraded = { ...base, process: { ...base.process, state: 'degraded' as const } };
    expect(isTunnelRunning(degraded)).toBe(true);
    expect(wouldDropLastProtection(degraded)).toBe(true);
  });
});

describe('checkNotice', () => {
  test('ok：本机经公网地址可达', () => {
    expect(checkNotice({ ok: true, message: null, step: 'ok', code: null })).toEqual({
      tone: 'success',
      testId: 'remote-access-check-ok',
      key: 'settings.remoteAccess.check.reachable',
      message: null,
      detail: null,
    });
  });

  test('access_protected：连接器已验证，仍算成功', () => {
    const notice = checkNotice({ ok: true, message: null, step: 'access_protected', code: null });
    expect(notice.tone).toBe('success');
    expect(notice.key).toBe('settings.remoteAccess.check.accessProtected');
  });

  test('access_protected_unverified：证明不了本机可达，降成警示', () => {
    const notice = checkNotice({
      ok: true,
      message: null,
      step: 'access_protected_unverified',
      code: null,
    });
    expect(notice.tone).toBe('warning');
    expect(notice.testId).toBe('remote-access-check-warning');
    expect(notice.key).toBe('settings.remoteAccess.check.accessProtectedUnverified');
  });

  test('旧后端没有 step 时退回通用的成功文案', () => {
    expect(checkNotice({ ok: true, message: null, step: null, code: null }).key).toBe(
      'settings.remoteAccess.check.reachable'
    );
  });

  test('connector_down：服务端描述插进错误文案，不再另起一行', () => {
    expect(
      checkNotice({
        ok: false,
        message: 'no edge connections',
        step: 'check',
        code: 'connector_down',
      })
    ).toEqual({
      tone: 'error',
      testId: 'remote-access-check-failed',
      key: 'settings.remoteAccess.errors.connector_down',
      message: 'no edge connections',
      detail: null,
    });
  });

  test('其它失败：通用不可达 + 服务端原始描述', () => {
    expect(
      checkNotice({ ok: false, message: '502 bad gateway', step: 'check', code: 'unknown' })
    ).toEqual({
      tone: 'error',
      testId: 'remote-access-check-failed',
      key: 'settings.remoteAccess.check.unreachable',
      message: null,
      detail: '502 bad gateway',
    });
  });
});

describe('wizardSteps / effectivePath / effectiveMode', () => {
  const ctx = (chosenPath: 'tunnel' | 'direct' | null, chosenMode: 'named' | 'quick' | null) => ({
    status: status(),
    chosenPath,
    chosenMode,
    hostnameConfirmed: false,
  });

  test('还没选连接方式时只有顶层的一步', () => {
    expect(wizardSteps(ctx(null, null))).toEqual(['path']);
    expect(wizardSteps(ctx(null, 'named'))).toEqual(['path']);
  });

  test('命名隧道八步：访问控制排在主机名之后、创建之前', () => {
    expect(wizardSteps(ctx('tunnel', 'named'))).toEqual([
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

  test('临时隧道没有登录 / 主机名 / 访问控制', () => {
    expect(wizardSteps(ctx('tunnel', 'quick'))).toEqual([
      'path',
      'install',
      'mode',
      'quick',
      'proxy',
    ]);
  });

  test('选了隧道但还没选类型时第 4 步只是占位', () => {
    expect(wizardSteps(ctx('tunnel', null))).toEqual([
      'path',
      'install',
      'mode',
      'tunnel',
      'proxy',
    ]);
  });

  test('已经建好隧道后连接方式与类型都以服务端为准', () => {
    const s = status({ config: { ...status().config, mode: 'named', hostname: 'a.example.com' } });
    expect(effectivePath(s, 'direct')).toBe('tunnel');
    expect(effectiveMode(s, 'quick')).toBe('named');
    expect(
      wizardSteps({
        status: s,
        chosenPath: 'direct',
        chosenMode: 'quick',
        hostnameConfirmed: false,
      })
    ).toContain('access');
  });

  test('未配置时连接方式与类型都取本地选择', () => {
    expect(effectivePath(status(), null)).toBeNull();
    expect(effectivePath(status(), 'direct')).toBe('direct');
    expect(effectiveMode(status(), 'quick')).toBe('quick');
    expect(effectiveMode(status(), null)).toBe('off');
  });
});

describe('wizardStepState', () => {
  const ctx = (
    s: TunnelStatusResponse,
    chosenMode: 'named' | 'quick' | null,
    hostnameConfirmed = false
  ) => ({ status: s, chosenPath: 'tunnel' as const, chosenMode, hostnameConfirmed });

  test('选好连接方式后第 1 步打勾，没选时停在第 1 步', () => {
    expect(wizardStepState('path', ctx(status(), null))).toBe('done');
    expect(
      wizardStepState('path', {
        status: status(),
        chosenPath: null,
        chosenMode: null,
        hostnameConfirmed: false,
      })
    ).toBe('current');
  });

  test('没装 cloudflared 时停在安装步', () => {
    const s = status({ binary: { installed: false, version: null, path: null, source: null } });
    expect(wizardStepState('install', ctx(s, 'named'))).toBe('current');
    expect(wizardStepState('mode', ctx(s, 'named'))).toBe('todo');
  });

  test('装好但没选方式时停在方式步', () => {
    expect(wizardStepState('install', ctx(status(), null))).toBe('done');
    expect(wizardStepState('mode', ctx(status(), null))).toBe('current');
  });

  test('命名隧道：登录 → 主机名 → 创建依次推进', () => {
    const notLoggedIn = status();
    expect(wizardStepState('login', ctx(notLoggedIn, 'named'))).toBe('current');
    expect(wizardStepState('hostname', ctx(notLoggedIn, 'named'))).toBe('todo');
    expect(wizardStepState('create', ctx(notLoggedIn, 'named'))).toBe('todo');

    const loggedIn = status({ auth: { loggedIn: true, loginUrl: null } });
    expect(wizardStepState('login', ctx(loggedIn, 'named'))).toBe('done');
    expect(wizardStepState('hostname', ctx(loggedIn, 'named'))).toBe('current');
    expect(wizardStepState('create', ctx(loggedIn, 'named'))).toBe('todo');

    expect(wizardStepState('hostname', ctx(loggedIn, 'named', true))).toBe('done');
    expect(wizardStepState('create', ctx(loggedIn, 'named', true))).toBe('current');
  });

  test('访问控制步：主机名没确认前一律待办，确认后按选定的方式推进', () => {
    const auth = { loggedIn: true, loginUrl: null };
    const withMode = (s: TunnelStatusResponse, accessMode: TunnelAccessMode) => ({
      ...s,
      config: { ...s.config, accessMode },
    });
    // 与创建步同一条门槛：主机名还没确认时不抢当前步。
    expect(wizardStepState('access', ctx(status({ auth }), 'named'))).toBe('todo');

    // 什么都没选、也没有登录门：停在当前步等用户选。
    const undecided = status({ auth, loginEnforced: false });
    expect(wizardStepState('access', ctx(undecided, 'named', true))).toBe('current');

    // 有登录门时推导成「账号密码」，直接打勾。
    expect(wizardStepState('access', ctx(status({ auth }), 'named', true))).toBe('done');

    // 明确选了「无」也算做完这一步。
    expect(wizardStepState('access', ctx(withMode(undecided, 'none'), 'named', true))).toBe('done');

    // 选了 Cloudflare Access 但还没生效：停在当前步；生效后打勾。
    expect(wizardStepState('access', ctx(withMode(undecided, 'cloudflare'), 'named', true))).toBe(
      'current'
    );
    expect(wizardStepState('access', ctx(withAccess({}, { auth }), 'named', true))).toBe('done');
  });

  test('隧道建好后创建步打勾、反向代理步成为当前步', () => {
    const s = status({ config: { ...status().config, mode: 'named', hostname: 'a.example.com' } });
    expect(wizardStepState('create', ctx(s, 'named'))).toBe('done');
    expect(wizardStepState('hostname', ctx(s, 'named'))).toBe('done');
    expect(wizardStepState('proxy', ctx(s, 'named'))).toBe('current');
  });

  test('接管系统隧道时安装与登录直接算完成', () => {
    const s = status({
      binary: { installed: false, version: null, path: null, source: null },
      config: { ...status().config, mode: 'named', externallyManaged: true },
    });
    expect(wizardStepState('install', ctx(s, 'named'))).toBe('done');
    expect(wizardStepState('login', ctx(s, 'named'))).toBe('done');
  });

  test('临时隧道启动前是当前步，启动后打勾', () => {
    expect(wizardStepState('quick', ctx(status(), 'quick'))).toBe('current');
    const started = status({ config: { ...status().config, mode: 'quick' } });
    expect(wizardStepState('quick', ctx(started, 'quick'))).toBe('done');
  });
});

describe('直接连接路径', () => {
  const notInstalled = { installed: false, version: null, path: null, source: null } as const;
  const localAuth = (overrides: Partial<LocalAuthStatus> = {}): LocalAuthStatus => ({
    supported: true,
    enabled: false,
    effective: false,
    credentialsPresent: false,
    ...overrides,
  });
  const ctx = (
    s: TunnelStatusResponse,
    auth?: LocalAuthStatus
  ): Parameters<typeof wizardStepState>[1] => ({
    status: s,
    chosenPath: 'direct',
    chosenMode: null,
    hostnameConfirmed: false,
    localAuth: auth ?? null,
  });

  test('只有连接方式与访问保护两步：不建隧道就不需要安装与反向代理', () => {
    expect(
      wizardSteps({
        status: status(),
        chosenPath: 'direct',
        chosenMode: null,
        hostnameConfirmed: false,
      })
    ).toEqual(['path', 'direct']);
  });

  test('没装 cloudflared 也走得通：连接方式步照样打勾', () => {
    const s = status({ binary: notInstalled });
    expect(
      wizardSteps({ status: s, chosenPath: 'direct', chosenMode: null, hostnameConfirmed: false })
    ).toEqual(['path', 'direct']);
    expect(wizardStepState('path', ctx(s))).toBe('done');
  });

  test('访问保护步：查到门才打勾', () => {
    expect(wizardStepState('direct', ctx(status(), localAuth({ supported: false })))).toBe('done');
    expect(
      wizardStepState(
        'direct',
        ctx(status(), localAuth({ enabled: true, effective: true, credentialsPresent: true }))
      )
    ).toBe('done');
  });

  test('没门 / 后端没下发状态都停在当前步——未知绝不当成已保护', () => {
    expect(wizardStepState('direct', ctx(status(), localAuth()))).toBe('current');
    expect(wizardStepState('direct', ctx(status()))).toBe('current');
  });

  test('隧道路径里访问保护步既不出现，也不会抢当前步', () => {
    const quick = {
      status: status(),
      chosenPath: 'tunnel' as const,
      chosenMode: 'quick' as const,
      hostnameConfirmed: false,
    };
    expect(wizardSteps(quick)).not.toContain('direct');
    expect(wizardStepState('direct', quick)).toBe('todo');
  });

  test('服务端已建隧道时本地的 direct 选择让位给隧道路径', () => {
    const s = status({ config: { ...status().config, mode: 'quick' } });
    expect(effectivePath(s, 'direct')).toBe('tunnel');
    expect(
      wizardSteps({ status: s, chosenPath: 'direct', chosenMode: null, hostnameConfirmed: false })
    ).toEqual(['path', 'install', 'mode', 'quick', 'proxy']);
  });
});

/** 已建好并跑起来的命名隧道，Access 应用绑在同一主机名上。 */
function withAccess(
  accessOverrides: Partial<TunnelStatusResponse['access']> = {},
  overrides: Partial<TunnelStatusResponse> = {}
): TunnelStatusResponse {
  const base = status(overrides);
  return {
    ...base,
    config: { ...base.config, mode: 'named', hostname: 'tmex.example.com' },
    process: { ...base.process, state: 'running' },
    access: {
      ...base.access,
      configured: true,
      enforceJwt: true,
      hostname: 'tmex.example.com',
      effective: true,
      ...accessOverrides,
    },
  };
}

describe('accessEffective', () => {
  test('以后端的 effective 为准', () => {
    expect(accessEffective(withAccess())).toBe(true);
    expect(accessEffective(withAccess({ effective: false }))).toBe(false);
  });

  test('旧后端没有 effective 时按同一条谓词兜底', () => {
    const legacy = (s: TunnelStatusResponse): TunnelStatusResponse => {
      const { effective: _effective, ...access } = s.access;
      return { ...s, access: access as TunnelStatusResponse['access'] };
    };
    expect(accessEffective(legacy(withAccess()))).toBe(true);
    expect(accessEffective(legacy(withAccess({ enforceJwt: false })))).toBe(false);
    expect(accessEffective(legacy(withAccess({ hostname: 'old.example.com' })))).toBe(false);
    // 两边都没有主机名不算匹配：没有隧道就谈不上保护。
    expect(
      accessEffective(
        legacy(withAccess({ hostname: null }, { config: { ...status().config, mode: 'off' } }))
      )
    ).toBe(false);
  });
});

describe('accessPill', () => {
  test('未配置 / 已配置未强制 / 主机名不匹配 / 已保护', () => {
    expect(accessPill(status())).toBe('notConfigured');
    expect(accessPill(withAccess({ enforceJwt: false, effective: false }))).toBe('notEnforced');
    expect(accessPill(withAccess({ hostname: 'old.example.com', effective: false }))).toBe(
      'hostnameMismatch'
    );
    expect(accessPill(withAccess())).toBe('protected');
  });

  test('tmex 没托管应用时用只读探测：控制台已覆盖 / 查不了 / 查过了没有', () => {
    const named = (
      externalAccess: TunnelStatusResponse['external']['externalAccess'] | undefined
    ): TunnelStatusResponse => {
      const base = status();
      return {
        ...base,
        config: { ...base.config, mode: 'named', hostname: 'tmex.example.com' },
        external: { ...base.external, externalAccess },
      };
    };
    const probe = (
      over: Partial<NonNullable<TunnelStatusResponse['external']['externalAccess']>>
    ) => ({
      checked: true,
      hostnameMatch: false,
      appId: null,
      aud: null,
      teamDomain: null,
      ...over,
    });

    expect(accessPill(named(probe({ hostnameMatch: true, appId: 'app-1' })))).toBe(
      'dashboardCovered'
    );
    expect(accessPill(named(probe({ checked: false })))).toBe('unknown');
    // 旧后端不下发探测结果：同样是「查不了」，不能说成未配置。
    expect(accessPill(named(undefined))).toBe('unknown');
    expect(accessPill(named(probe({})))).toBe('notConfigured');
    // 连主机名都没有时没什么可查的，「未配置」才是准确的说法。
    expect(accessPill(status())).toBe('notConfigured');
  });

  test('tmex 已托管的应用优先于只读探测', () => {
    const covered = {
      checked: true,
      hostnameMatch: true,
      appId: 'app-1',
      aud: 'aud-1',
      teamDomain: 'team.cloudflareaccess.com',
    };
    const base = withAccess();
    expect(accessPill({ ...base, external: { ...base.external, externalAccess: covered } })).toBe(
      'protected'
    );
  });
});

describe('protectionPill', () => {
  const withMode = (s: TunnelStatusResponse, accessMode: TunnelAccessMode) => ({
    ...s,
    config: { ...s.config, accessMode },
  });

  test('实际保护优先：Access 校验生效就报「已生效」，与选了什么无关', () => {
    expect(protectionPill(withMode(withAccess(), 'cloudflare'))).toBe('protected');
    // 用户选了「无」但应用还生效：徽标必须照实报，否则会让人以为已经没有保护了。
    expect(protectionPill(withMode(withAccess(), 'none'))).toBe('protected');
    expect(protectionPill(withMode(withAccess(), 'login'))).toBe('protected');
    expect(protectionPill(withAccess({}, { loginEnforced: false }))).toBe('protected');
  });

  test('没有 Access 校验但有登录门：报登录保护', () => {
    expect(protectionPill(status())).toBe('loginProtected');
    expect(protectionPill(withMode(status(), 'login'))).toBe('loginProtected');
    // 选了「无」也一样：登录门确实还在，不能报没有保护。
    expect(protectionPill(withMode(status(), 'none'))).toBe('loginProtected');
  });

  test('两样保护都没有时才按选定的方式解释差在哪', () => {
    const bare = status({ loginEnforced: false });
    expect(protectionPill(withMode(bare, 'login'))).toBe('loginMissing');
    expect(protectionPill(withMode(bare, 'none'))).toBe('unprotected');
    // 从没选过、也没有任何应用：没有保护就是没有保护。
    expect(protectionPill(bare)).toBe('unprotected');
    // 选了 Access（或旧数据里留着一个没生效的应用）：沿用 Access 的诊断徽标。
    expect(protectionPill(withMode(bare, 'cloudflare'))).toBe('notConfigured');
    expect(
      protectionPill(
        withMode(
          withAccess({ enforceJwt: false, effective: false }, { loginEnforced: false }),
          'cloudflare'
        )
      )
    ).toBe('notEnforced');
    expect(
      protectionPill(
        withAccess({ hostname: 'old.example.com', effective: false }, { loginEnforced: false })
      )
    ).toBe('hostnameMismatch');
  });
});

describe('tunnelExposed', () => {
  test('托管进程只要不是「已停止」就算暴露，含自启动失败留下的 error', () => {
    const base = withAccess({}, { loginEnforced: false });
    const withState = (state: TunnelStatusResponse['process']['state']) => ({
      ...base,
      process: { ...base.process, state },
    });
    expect(tunnelExposed(withState('running'))).toBe(true);
    expect(tunnelExposed(withState('starting'))).toBe(true);
    expect(tunnelExposed(withState('degraded'))).toBe(true);
    // 后端的 runningEnabled 状态里看不到：自启动超时会停在 error，但拉起意图还在。
    expect(tunnelExposed(withState('error'))).toBe(true);
    expect(tunnelExposed(withState('stopped'))).toBe(false);
  });

  test('没建隧道就谈不上暴露', () => {
    const base = withAccess({}, { loginEnforced: false });
    expect(
      tunnelExposed({
        ...base,
        config: { ...base.config, mode: 'off' },
        process: { ...base.process, state: 'error' },
      })
    ).toBe(false);
  });

  test('接管来的隧道看探测结果，探测进行中一并算暴露', () => {
    const base = withAccess({}, { loginEnforced: false });
    const adopted = (external: Partial<TunnelStatusResponse['external']>) => ({
      ...base,
      config: { ...base.config, externallyManaged: true },
      process: { ...base.process, state: 'stopped' as const },
      external: { ...base.external, detected: true, running: false, ...external },
    });
    expect(tunnelExposed(adopted({ running: true }))).toBe(true);
    // 探测还没有结论：后端拿不到结果时同样会拦，前端跟着算暴露。
    expect(tunnelExposed(adopted({ probing: true }))).toBe(true);
    expect(tunnelExposed(adopted({}))).toBe(false);
  });
});

describe('wouldDropLastProtection', () => {
  test('与后端一致：隧道暴露着且没有登录就要确认，与 Access 是否生效无关', () => {
    expect(wouldDropLastProtection(withAccess({}, { loginEnforced: false }))).toBe(true);
    // 启用了登录：拿掉 Access 还有登录兜底。
    expect(wouldDropLastProtection(withAccess({}, { loginEnforced: true }))).toBe(false);
    // Access 绑的是别的主机名、校验没生效：后端照样拦，勾选必须提前摆出来。
    expect(
      wouldDropLastProtection(
        withAccess({ hostname: 'old.example.com', effective: false }, { loginEnforced: false })
      )
    ).toBe(true);
    // 连令牌校验都关着：同样是暴露中的隧道，后端一样要确认。
    expect(
      wouldDropLastProtection(
        withAccess({ enforceJwt: false, effective: false }, { loginEnforced: false })
      )
    ).toBe(true);
  });

  test('隧道没跑起来就不算暴露', () => {
    const stopped = withAccess({}, { loginEnforced: false });
    expect(
      wouldDropLastProtection({ ...stopped, process: { ...stopped.process, state: 'stopped' } })
    ).toBe(false);
  });

  test('接管来的隧道按探测到的运行态判定', () => {
    const adopted = withAccess({}, { loginEnforced: false });
    const external = {
      ...adopted,
      config: { ...adopted.config, externallyManaged: true },
      process: { ...adopted.process, state: 'stopped' as const },
      external: { ...adopted.external, detected: true, running: true },
    };
    expect(isTunnelRunning(external)).toBe(true);
    expect(wouldDropLastProtection(external)).toBe(true);
  });
});

describe('暴露确认', () => {
  test('只有会把 tmex 开放出去的动作才需要确认', () => {
    expect(isExposingAction({ action: 'quick_start' })).toBe(true);
    expect(isExposingAction({ action: 'start' })).toBe(true);
    expect(isExposingAction({ action: 'create', hostname: 'a.example.com' })).toBe(true);
    expect(isExposingAction({ action: 'set_auto_start', autoStart: true })).toBe(true);
    // 关掉自启动是收敛，不需要确认。
    expect(isExposingAction({ action: 'set_auto_start', autoStart: false })).toBe(false);
    expect(isExposingAction({ action: 'stop' })).toBe(false);
    expect(isExposingAction({ action: 'install' })).toBe(false);
  });

  test('把访问控制改成「无」是开放性动作，改成其他方式不是', () => {
    expect(isExposingAction({ action: 'set_access_mode', accessMode: 'none' })).toBe(true);
    expect(isExposingAction({ action: 'set_access_mode', accessMode: 'login' })).toBe(false);
    expect(isExposingAction({ action: 'set_access_mode', accessMode: 'cloudflare' })).toBe(false);
    expect(withExposureAck({ action: 'set_access_mode', accessMode: 'none' }, true)).toEqual({
      action: 'set_access_mode',
      accessMode: 'none',
      acknowledgeExposure: true,
    });
    expect(withExposureAck({ action: 'set_access_mode', accessMode: 'none' }, false)).toEqual({
      action: 'set_access_mode',
      accessMode: 'none',
    });
    expect(withExposureAck({ action: 'set_access_mode', accessMode: 'login' }, true)).toEqual({
      action: 'set_access_mode',
      accessMode: 'login',
    });
  });

  test('拿掉最后一道保护的动作同样算开放性动作', () => {
    expect(isExposingAction({ action: 'remove_access' })).toBe(true);
    expect(isExposingAction({ action: 'set_access_enforce', enforceJwt: false })).toBe(true);
    // 打开校验是收敛动作。
    expect(isExposingAction({ action: 'set_access_enforce', enforceJwt: true })).toBe(false);
    expect(withExposureAck({ action: 'remove_access' }, true)).toEqual({
      action: 'remove_access',
      acknowledgeExposure: true,
    });
    expect(withExposureAck({ action: 'set_access_enforce', enforceJwt: false }, true)).toEqual({
      action: 'set_access_enforce',
      enforceJwt: false,
      acknowledgeExposure: true,
    });
    expect(withExposureAck({ action: 'set_access_enforce', enforceJwt: true }, true)).toEqual({
      action: 'set_access_enforce',
      enforceJwt: true,
    });
  });

  test('没勾确认时请求不带 acknowledgeExposure', () => {
    expect(withExposureAck({ action: 'quick_start' }, false)).toEqual({ action: 'quick_start' });
    expect(withExposureAck({ action: 'quick_start' }, true)).toEqual({
      action: 'quick_start',
      acknowledgeExposure: true,
    });
  });

  test('非开放性动作即使勾了也不加这个字段', () => {
    expect(withExposureAck({ action: 'stop' }, true)).toEqual({ action: 'stop' });
  });

  test('动作错误或 job 错误任一为 exposure_ack_required 都要弹确认', () => {
    expect(isExposureAckError(status(), null)).toBe(false);
    expect(isExposureAckError(status(), { code: 'exposure_ack_required', message: 'ack' })).toBe(
      true
    );
    expect(
      isExposureAckError(
        status({
          job: {
            id: 'j1',
            kind: 'start',
            state: 'error',
            step: null,
            error: { code: 'exposure_ack_required', message: 'ack' },
            startedAt: '2026-08-30T00:00:00.000Z',
            finishedAt: '2026-08-30T00:00:01.000Z',
          },
        }),
        null
      )
    ).toBe(true);
  });
});

describe('isValidHostname', () => {
  test('接受小写多级主机名', () => {
    expect(isValidHostname('tmex.example.com')).toBe(true);
    expect(isValidHostname('a-b.c-d.example.co.uk')).toBe(true);
  });

  test('拒绝大写、单级、空标签、首尾连字符与超长标签', () => {
    expect(isValidHostname('TMEX.example.com')).toBe(false);
    expect(isValidHostname('example')).toBe(false);
    expect(isValidHostname('')).toBe(false);
    expect(isValidHostname('a..com')).toBe(false);
    expect(isValidHostname('-a.example.com')).toBe(false);
    expect(isValidHostname('a-.example.com')).toBe(false);
    expect(isValidHostname(`${'a'.repeat(64)}.example.com`)).toBe(false);
    expect(isValidHostname('tmex.example.com/path')).toBe(false);
  });
});

describe('isValidTunnelName', () => {
  test('接受小写字母、数字、连字符与下划线', () => {
    expect(isValidTunnelName('tmex')).toBe(true);
    expect(isValidTunnelName('tmex-01_a')).toBe(true);
    expect(isValidTunnelName('9')).toBe(true);
  });

  test('拒绝路径分隔符、点、大写、空串与超长名称', () => {
    expect(isValidTunnelName('../../package')).toBe(false);
    expect(isValidTunnelName('a/b')).toBe(false);
    expect(isValidTunnelName('a\\b')).toBe(false);
    expect(isValidTunnelName('a.b')).toBe(false);
    expect(isValidTunnelName('Tmex')).toBe(false);
    expect(isValidTunnelName('')).toBe(false);
    expect(isValidTunnelName('-tmex')).toBe(false);
    expect(isValidTunnelName('_tmex')).toBe(false);
    expect(isValidTunnelName('a'.repeat(64))).toBe(false);
    expect(isValidTunnelName('a'.repeat(63))).toBe(true);
  });
});

describe('jobStepKey', () => {
  test('后端实际发出的步骤全部有文案键', () => {
    for (const step of [
      'download',
      'extract',
      'verify',
      'login',
      'wait_cert',
      'cancelled',
      'create',
      'route_dns',
      'start',
      'check',
      'ok',
      'create_app',
      'policy',
      'delete_app',
      'sync',
    ]) {
      expect(jobStepKey(step)).toBe(`settings.remoteAccess.jobStep.${step}`);
    }
  });

  test('未知或缺失步骤返回 null', () => {
    expect(jobStepKey('mystery')).toBeNull();
    expect(jobStepKey(null)).toBeNull();
  });
});

describe('trustProxyRestartRequired', () => {
  test('已保存值与生效值一致且后端没报重启时不提示', () => {
    expect(trustProxyRestartRequired(status())).toBe(false);
  });

  test('已保存值与生效值不一致即需重启', () => {
    expect(trustProxyRestartRequired(status({ configuredTrustProxy: true }))).toBe(true);
  });

  test('后端自报需要重启时也提示', () => {
    expect(trustProxyRestartRequired(status({ restartRequired: true }))).toBe(true);
  });
});

describe('isAuthRequiredError', () => {
  test('动作错误或 job 错误任一为 auth_required 都算', () => {
    expect(isAuthRequiredError(status(), null)).toBe(false);
    expect(isAuthRequiredError(status(), { code: 'busy', message: 'busy' })).toBe(false);
    expect(isAuthRequiredError(status(), { code: 'auth_required', message: 'no user' })).toBe(true);
    expect(
      isAuthRequiredError(
        status({
          job: {
            id: 'j1',
            kind: 'create',
            state: 'error',
            step: null,
            error: { code: 'auth_required', message: 'no user' },
            startedAt: '2026-08-30T00:00:00.000Z',
            finishedAt: '2026-08-30T00:00:01.000Z',
          },
        }),
        null
      )
    ).toBe(true);
  });
});

describe('错误映射', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${JSON.stringify(options)}` : key;

  test('已知错误码走本地化键', () => {
    expect(tunnelErrorKey('login_timeout')).toBe('settings.remoteAccess.errors.login_timeout');
    expect(tunnelErrorKey('auth_required')).toBe('settings.remoteAccess.errors.auth_required');
    expect(describeTunnelError(t, { code: 'busy', message: 'busy' })).toBe(
      'settings.remoteAccess.errors.busy'
    );
  });

  test('Access API 失败带上服务端的原始描述', () => {
    expect(describeTunnelError(t, { code: 'access_api_failed', message: 'token invalid' })).toBe(
      'settings.remoteAccess.errors.access_api_failed:{"message":"token invalid"}'
    );
  });

  test('connector_down 带上服务端的原始描述', () => {
    expect(tunnelErrorKey('connector_down')).toBe('settings.remoteAccess.errors.connector_down');
    expect(describeTunnelError(t, { code: 'connector_down', message: '0 connections' })).toBe(
      'settings.remoteAccess.errors.connector_down:{"message":"0 connections"}'
    );
  });

  test('exposure_ack_required 有自己的文案', () => {
    expect(tunnelErrorKey('exposure_ack_required')).toBe(
      'settings.remoteAccess.errors.exposure_ack_required'
    );
  });

  test('未知码退化成带原始 message 的兜底文案', () => {
    expect(tunnelErrorKey('nope')).toBeNull();
    expect(describeTunnelError(t, { code: 'unknown', message: 'boom' })).toBe(
      'settings.remoteAccess.errors.unknown:{"message":"boom"}'
    );
  });

  test('TunnelApiError 保留 code 与 message，其它异常落到 unknown', () => {
    expect(toTunnelError(new TunnelApiError('dns_route_failed', 'no zone', 400))).toEqual({
      code: 'dns_route_failed',
      message: 'no zone',
    });
    expect(toTunnelError(new Error('network down'))).toEqual({
      code: 'unknown',
      message: 'network down',
    });
  });
});

describe('tunnelPollInterval', () => {
  test('job 在跑或进程正在起来时 2 秒一拉', () => {
    expect(
      tunnelPollInterval(
        status({
          job: {
            id: 'j1',
            kind: 'install',
            state: 'running',
            step: 'download',
            error: null,
            startedAt: '2026-08-30T00:00:00.000Z',
            finishedAt: null,
          },
        })
      )
    ).toBe(TUNNEL_ACTIVE_POLL_MS);
    expect(
      tunnelPollInterval(status({ process: { ...status().process, state: 'starting' } }))
    ).toBe(TUNNEL_ACTIVE_POLL_MS);
  });

  test('空闲时 10 秒一拉，没有快照也不加速', () => {
    expect(tunnelPollInterval(status())).toBe(TUNNEL_IDLE_POLL_MS);
    expect(tunnelPollInterval(null)).toBe(TUNNEL_IDLE_POLL_MS);
  });
});

describe('logTail', () => {
  test('不超过上限时原样返回同一个数组', () => {
    const log = ['a', 'b'];
    expect(logTail(log)).toBe(log);
  });

  test('超出上限只留末尾 200 行', () => {
    const log = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    const tail = logTail(log);
    expect(tail).toHaveLength(200);
    expect(tail[0]).toBe('line 50');
    expect(tail[199]).toBe('line 249');
  });
});
