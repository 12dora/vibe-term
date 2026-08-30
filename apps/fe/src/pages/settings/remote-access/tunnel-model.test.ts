// 远程访问的纯推导：状态徽标、向导步进、主机名校验、轮询节奏与错误 / 进度文案键。

import { describe, expect, test } from 'bun:test';
import { TunnelApiError } from '@tmex/api-client/local/tunnel-api';
import type { TunnelStatusResponse } from '@tmex/shared';
import {
  TUNNEL_ACTIVE_POLL_MS,
  TUNNEL_IDLE_POLL_MS,
  accessPill,
  describeTunnelError,
  effectiveMode,
  isAuthRequiredError,
  isExposingAction,
  isExposureAckError,
  isValidHostname,
  isValidTunnelName,
  jobStepKey,
  logTail,
  toTunnelError,
  trustProxyRestartRequired,
  tunnelErrorKey,
  tunnelPill,
  tunnelPollInterval,
  withExposureAck,
  wizardStepState,
  wizardSteps,
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
    },
    process: {
      state: 'stopped',
      pid: null,
      startedAt: null,
      publicUrl: null,
      lastError: null,
      restarts: 0,
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

describe('wizardSteps / effectiveMode', () => {
  test('命名隧道七步：访问控制排在主机名之后、创建之前', () => {
    expect(
      wizardSteps({ status: status(), chosenMode: 'named', hostnameConfirmed: false })
    ).toEqual(['install', 'mode', 'login', 'hostname', 'access', 'create', 'proxy']);
  });

  test('临时隧道没有登录 / 主机名 / 访问控制', () => {
    expect(
      wizardSteps({ status: status(), chosenMode: 'quick', hostnameConfirmed: false })
    ).toEqual(['install', 'mode', 'quick', 'proxy']);
  });

  test('还没选方式时第 3 步只是占位', () => {
    expect(wizardSteps({ status: status(), chosenMode: null, hostnameConfirmed: false })).toEqual([
      'install',
      'mode',
      'tunnel',
      'proxy',
    ]);
  });

  test('已经建好隧道后方式以服务端为准', () => {
    const s = status({ config: { ...status().config, mode: 'named', hostname: 'a.example.com' } });
    expect(effectiveMode(s, 'quick')).toBe('named');
    expect(wizardSteps({ status: s, chosenMode: 'quick', hostnameConfirmed: false })).toContain(
      'access'
    );
  });

  test('未配置时方式取本地选择', () => {
    expect(effectiveMode(status(), 'quick')).toBe('quick');
    expect(effectiveMode(status(), null)).toBe('off');
  });
});

describe('wizardStepState', () => {
  const ctx = (
    s: TunnelStatusResponse,
    chosenMode: 'named' | 'quick' | null,
    hostnameConfirmed = false
  ) => ({ status: s, chosenMode, hostnameConfirmed });

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

  test('访问控制是可选步：没配就一直是待办，配了才打勾，绝不抢当前步', () => {
    const loggedIn = status({ auth: { loggedIn: true, loginUrl: null } });
    expect(wizardStepState('access', ctx(loggedIn, 'named', true))).toBe('todo');
    const configured = status({
      auth: { loggedIn: true, loginUrl: null },
      access: { ...status().access, configured: true },
    });
    expect(wizardStepState('access', ctx(configured, 'named', true))).toBe('done');
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

describe('accessPill', () => {
  test('未配置 / 已配置未强制 / 已保护', () => {
    expect(accessPill(status())).toBe('notConfigured');
    expect(
      accessPill(status({ access: { ...status().access, configured: true, enforceJwt: false } }))
    ).toBe('notEnforced');
    expect(
      accessPill(status({ access: { ...status().access, configured: true, enforceJwt: true } }))
    ).toBe('protected');
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
