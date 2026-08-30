// 远程访问的纯推导：状态徽标、向导步进、主机名校验、轮询节奏与错误 / 进度文案键。

import { describe, expect, test } from 'bun:test';
import { TunnelApiError } from '@tmex/api-client/local/tunnel-api';
import type { TunnelStatusResponse } from '@tmex/shared';
import {
  TUNNEL_ACTIVE_POLL_MS,
  TUNNEL_IDLE_POLL_MS,
  currentWizardStep,
  describeTunnelError,
  effectiveMode,
  isValidHostname,
  jobStepKey,
  logTail,
  stepState,
  toTunnelError,
  tunnelErrorKey,
  tunnelPill,
  tunnelPollInterval,
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

  test('进程报错优先于「未配置」：移除失败后不能显示成一片干净', () => {
    expect(
      tunnelPill(
        status({ process: { ...status().process, state: 'error', lastError: 'exit code 1' } })
      )
    ).toBe('error');
  });
});

describe('currentWizardStep / effectiveMode', () => {
  test('没装 cloudflared 一律停在第 1 步', () => {
    const s = status({ binary: { installed: false, version: null, path: null, source: null } });
    expect(currentWizardStep(s, 'named')).toBe(1);
  });

  test('装好但没选方式停在第 2 步，选了方式进第 3 步', () => {
    expect(currentWizardStep(status(), null)).toBe(2);
    expect(currentWizardStep(status(), 'quick')).toBe(3);
  });

  test('已经建好隧道直接进第 4 步，方式以服务端为准', () => {
    const s = status({ config: { ...status().config, mode: 'named', hostname: 'a.example.com' } });
    expect(currentWizardStep(s, 'quick')).toBe(4);
    expect(effectiveMode(s, 'quick')).toBe('named');
  });

  test('未配置时方式取本地选择', () => {
    expect(effectiveMode(status(), 'quick')).toBe('quick');
    expect(effectiveMode(status(), null)).toBe('off');
  });
});

describe('stepState', () => {
  test('当前步高亮、之前的步骤打勾、之后的步骤待办', () => {
    expect(stepState(1, 3)).toBe('done');
    expect(stepState(3, 3)).toBe('current');
    expect(stepState(4, 3)).toBe('todo');
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

describe('jobStepKey', () => {
  test('已知步骤给文案键', () => {
    expect(jobStepKey('download')).toBe('settings.remoteAccess.jobStep.download');
    expect(jobStepKey('route_dns')).toBe('settings.remoteAccess.jobStep.route_dns');
  });

  test('未知或缺失步骤返回 null', () => {
    expect(jobStepKey('mystery')).toBeNull();
    expect(jobStepKey(null)).toBeNull();
  });
});

describe('错误映射', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${JSON.stringify(options)}` : key;

  test('已知错误码走本地化键', () => {
    expect(tunnelErrorKey('login_timeout')).toBe('settings.remoteAccess.errors.login_timeout');
    expect(describeTunnelError(t, { code: 'busy', message: 'busy' })).toBe(
      'settings.remoteAccess.errors.busy'
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
