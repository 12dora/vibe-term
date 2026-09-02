// 「本机作为中继」三步的现状推导。

import { describe, expect, test } from 'bun:test';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import type { TunnelStatusResponse } from '@tmex/shared';
import { entryStatus, hubStatus } from './host-status';

const SELF = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const OTHER = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';

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

function named(overrides: Partial<TunnelStatusResponse> = {}): TunnelStatusResponse {
  const base = status();
  return status({
    config: { ...base.config, mode: 'named', hostname: 'tmex.example.com' },
    process: { ...base.process, state: 'running' },
    ...overrides,
  });
}

function mode(overrides: Partial<AuthModeResponse> = {}): AuthModeResponse {
  return {
    mode: 'mesh',
    nodeId: SELF,
    uid: 'user-1',
    username: 'alice',
    kdfParams: null,
    passkeyAvailable: false,
    passkeysForThisOrigin: false,
    hubNodeId: SELF,
    hubPublicUrl: 'https://tmex.example.com',
    ...overrides,
  };
}

describe('entryStatus', () => {
  test('命名隧道运行中：地址由主机名拼出，running 为真', () => {
    expect(entryStatus(named(), null)).toEqual({
      kind: 'named',
      url: 'https://tmex.example.com',
      running: true,
      degraded: false,
      hostname: 'tmex.example.com',
    });
  });

  test('命名隧道已停止', () => {
    const stopped = status({
      config: { ...named().config },
      process: { ...status().process, state: 'stopped' },
    });
    expect(entryStatus(stopped, null).running).toBe(false);
    expect(entryStatus(stopped, null).kind).toBe('named');
  });

  test('接管来的隧道：运行态看探测结果，不看本地进程', () => {
    const adopted = status({
      config: { ...named().config, externallyManaged: true },
      process: { ...status().process, state: 'stopped' },
      external: { ...status().external, detected: true, running: true, source: 'launchd' },
    });
    expect(entryStatus(adopted, null)).toEqual({
      kind: 'named',
      url: 'https://tmex.example.com',
      running: true,
      degraded: false,
      hostname: 'tmex.example.com',
    });
    const adoptedDown = status({
      config: { ...named().config, externallyManaged: true },
      process: { ...status().process, state: 'running' },
      external: { ...status().external, detected: true, running: false, source: 'launchd' },
    });
    expect(entryStatus(adoptedDown, null).running).toBe(false);
  });

  test('进程在跑但连接器零连接：不算可达，单独标 degraded', () => {
    const zero = status({
      config: { ...named().config },
      process: { ...status().process, state: 'running' },
      connector: {
        reachable: true,
        metricsAddr: '127.0.0.1:20241',
        readyConnections: 0,
        connectorId: 'c-1',
        checkedAt: '2026-09-02T00:00:00.000Z',
        lastError: 'failed to connect to edge',
      },
    });
    expect(entryStatus(zero, null).running).toBe(false);
    expect(entryStatus(zero, null).degraded).toBe(true);
  });

  test('metrics 端点探不到（reachable=false）不算断线：后端仍报 running 就是 running', () => {
    const unprobed = status({
      config: { ...named().config },
      process: { ...status().process, state: 'running' },
      connector: {
        reachable: false,
        metricsAddr: '127.0.0.1:20241',
        readyConnections: null,
        connectorId: null,
        checkedAt: '2026-09-02T00:00:00.000Z',
        lastError: null,
      },
    });
    expect(entryStatus(unprobed, null).degraded).toBe(false);
    expect(entryStatus(unprobed, null).running).toBe(true);
  });

  test('后端直接给 degraded 态时同样不算可达', () => {
    const degraded = status({
      config: { ...named().config },
      process: { ...status().process, state: 'degraded' },
    });
    expect(entryStatus(degraded, null).running).toBe(false);
    expect(entryStatus(degraded, null).degraded).toBe(true);
  });

  test('接管来的隧道：进程在跑但零连接照样 degraded', () => {
    const adopted = status({
      config: { ...named().config, externallyManaged: true },
      external: { ...status().external, detected: true, running: true, source: 'launchd' },
      connector: {
        reachable: true,
        metricsAddr: '127.0.0.1:20241',
        readyConnections: 0,
        connectorId: 'c-1',
        checkedAt: '2026-09-02T00:00:00.000Z',
        lastError: null,
      },
    });
    expect(entryStatus(adopted, null).running).toBe(false);
    expect(entryStatus(adopted, null).degraded).toBe(true);
  });

  test('已停止不叫 degraded：连接器探测结果不改变结论', () => {
    const stopped = status({
      config: { ...named().config },
      connector: {
        reachable: true,
        metricsAddr: null,
        readyConnections: 0,
        connectorId: null,
        checkedAt: '2026-09-02T00:00:00.000Z',
        lastError: null,
      },
    });
    expect(entryStatus(stopped, null).degraded).toBe(false);
    expect(entryStatus(stopped, null).running).toBe(false);
  });

  test('临时隧道：地址取进程给的 trycloudflare 地址，没有主机名可比对', () => {
    const quick = status({
      config: { ...status().config, mode: 'quick' },
      process: {
        ...status().process,
        state: 'running',
        publicUrl: 'https://odd-name.trycloudflare.com',
      },
    });
    expect(entryStatus(quick, null)).toEqual({
      kind: 'quick',
      url: 'https://odd-name.trycloudflare.com',
      running: true,
      degraded: false,
      hostname: null,
    });
  });

  test('临时隧道还没起来（没有地址）：退回 Hub 公开地址', () => {
    const quick = status({ config: { ...status().config, mode: 'quick' } });
    expect(entryStatus(quick, 'https://hub.example.com').kind).toBe('hubUrl');
    expect(entryStatus(quick, null).kind).toBe('none');
  });

  test('没有隧道但有 Hub 公开地址（直接连接）：算已配置', () => {
    expect(entryStatus(status(), 'https://hub.example.com')).toEqual({
      kind: 'hubUrl',
      url: 'https://hub.example.com',
      running: false,
      degraded: false,
      hostname: null,
    });
  });

  test('隧道关闭且没有公开地址：什么都没配', () => {
    expect(entryStatus(status(), null).kind).toBe('none');
    expect(entryStatus(null, null).kind).toBe('none');
    expect(entryStatus(undefined, undefined).kind).toBe('none');
  });

  test('形状不完整的桩数据不崩', () => {
    expect(entryStatus({} as TunnelStatusResponse, null).kind).toBe('none');
  });
});

describe('hubStatus', () => {
  const entry = entryStatus(named(), null);

  test('本机就是 Hub：地址与隧道主机名一致时不报不一致', () => {
    expect(hubStatus(mode(), entry)).toEqual({
      role: 'self',
      url: 'https://tmex.example.com',
      mismatch: false,
    });
  });

  test('Hub 公开地址与隧道主机名对不上：标记 mismatch', () => {
    expect(hubStatus(mode({ hubPublicUrl: 'https://old.example.com' }), entry).mismatch).toBe(true);
  });

  test('没有命名隧道时不谈一致性', () => {
    const hubUrlOnly = entryStatus(status(), 'https://hub.example.com');
    expect(hubStatus(mode({ hubPublicUrl: 'https://hub.example.com' }), hubUrlOnly).mismatch).toBe(
      false
    );
    expect(
      hubStatus(mode({ hubPublicUrl: 'https://other.example.com' }), hubUrlOnly).mismatch
    ).toBe(false);
  });

  test('已作为节点接入别的 Hub', () => {
    expect(
      hubStatus(mode({ hubNodeId: OTHER, hubPublicUrl: 'https://hub.example.com' }), entry)
    ).toEqual({ role: 'node', url: 'https://hub.example.com', mismatch: false });
  });

  test('mesh 但没有 hubNodeId：按节点处理，不能自认 Hub', () => {
    expect(hubStatus(mode({ hubNodeId: null }), entry).role).toBe('node');
  });

  test('standalone / 尚未加载', () => {
    expect(hubStatus({ ...mode(), mode: 'none' }, entry).role).toBe('standalone');
    expect(hubStatus(null, entry)).toEqual({ role: 'standalone', url: null, mismatch: false });
    expect(hubStatus(undefined, entry).role).toBe('standalone');
  });
});
