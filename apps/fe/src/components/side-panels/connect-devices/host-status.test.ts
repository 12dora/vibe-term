// 隧道公网入口的现状推导。

import { describe, expect, test } from 'bun:test';
import type { TunnelStatusResponse } from '@vibeterm/shared';
import { entryStatus } from './host-status';

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
    config: { ...base.config, mode: 'named', hostname: 'vibeterm.example.com' },
    process: { ...base.process, state: 'running' },
    ...overrides,
  });
}

describe('entryStatus', () => {
  test('命名隧道运行中：地址由主机名拼出，running 为真', () => {
    expect(entryStatus(named())).toEqual({
      kind: 'named',
      url: 'https://vibeterm.example.com',
      running: true,
      degraded: false,
      hostname: 'vibeterm.example.com',
    });
  });

  test('命名隧道已停止', () => {
    const stopped = status({
      config: { ...named().config },
      process: { ...status().process, state: 'stopped' },
    });
    expect(entryStatus(stopped).running).toBe(false);
    expect(entryStatus(stopped).kind).toBe('named');
  });

  test('接管来的隧道：运行态看探测结果，不看本地进程', () => {
    const adopted = status({
      config: { ...named().config, externallyManaged: true },
      process: { ...status().process, state: 'stopped' },
      external: { ...status().external, detected: true, running: true, source: 'launchd' },
    });
    expect(entryStatus(adopted)).toEqual({
      kind: 'named',
      url: 'https://vibeterm.example.com',
      running: true,
      degraded: false,
      hostname: 'vibeterm.example.com',
    });
    const adoptedDown = status({
      config: { ...named().config, externallyManaged: true },
      process: { ...status().process, state: 'running' },
      external: { ...status().external, detected: true, running: false, source: 'launchd' },
    });
    expect(entryStatus(adoptedDown).running).toBe(false);
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
    expect(entryStatus(zero).running).toBe(false);
    expect(entryStatus(zero).degraded).toBe(true);
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
    expect(entryStatus(unprobed).degraded).toBe(false);
    expect(entryStatus(unprobed).running).toBe(true);
  });

  test('后端直接给 degraded 态时同样不算可达', () => {
    const degraded = status({
      config: { ...named().config },
      process: { ...status().process, state: 'degraded' },
    });
    expect(entryStatus(degraded).running).toBe(false);
    expect(entryStatus(degraded).degraded).toBe(true);
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
    expect(entryStatus(adopted).running).toBe(false);
    expect(entryStatus(adopted).degraded).toBe(true);
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
    expect(entryStatus(stopped).degraded).toBe(false);
    expect(entryStatus(stopped).running).toBe(false);
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
    expect(entryStatus(quick)).toEqual({
      kind: 'quick',
      url: 'https://odd-name.trycloudflare.com',
      running: true,
      degraded: false,
      hostname: null,
    });
  });

  test('临时隧道还没起来（没有地址）：算没配', () => {
    const quick = status({ config: { ...status().config, mode: 'quick' } });
    expect(entryStatus(quick).kind).toBe('none');
  });

  test('隧道关闭且没有公开地址：什么都没配', () => {
    expect(entryStatus(status()).kind).toBe('none');
    expect(entryStatus(null).kind).toBe('none');
    expect(entryStatus(undefined).kind).toBe('none');
  });

  test('形状不完整的桩数据不崩', () => {
    expect(entryStatus({} as TunnelStatusResponse).kind).toBe('none');
  });
});
