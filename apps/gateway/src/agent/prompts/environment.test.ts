import { describe, expect, test } from 'bun:test';
import os from 'node:os';
import type { Device } from '@tmex/shared';
import { collectAgentEnvironment } from './environment';

function device(overrides: Partial<Device> = {}): Device {
  return {
    id: 'dev-1',
    name: 'lab',
    type: 'ssh',
    authMode: 'key',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('collectAgentEnvironment', () => {
  test('null device 只保留时钟，设备与入口主机字段均为 null', () => {
    const env = collectAgentEnvironment(null);
    expect(env.deviceName).toBeNull();
    expect(env.deviceType).toBeNull();
    expect(env.host).toBeNull();
    expect(env.username).toBeNull();
    expect(env.port).toBeNull();
    expect(env.tmuxSession).toBeNull();
    expect(env.gatewayOs).toBeNull();
    expect(env.gatewayShell).toBeNull();
    expect(env.term).toBeNull();
    expect(env.termProgram).toBeNull();
    expect(env.locale).toBeNull();
    expect(env.encoding).toBeNull();
    expect(env.timezone.length).toBeGreaterThan(0);
    expect(env.nowIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('ssh 设备映射接入参数，不暴露入口主机 OS/shell', () => {
    const env = collectAgentEnvironment(
      device({
        name: 'edge',
        type: 'ssh',
        host: '10.0.0.1',
        username: 'admin',
        port: 22,
        session: 'ops',
      })
    );
    expect(env.deviceName).toBe('edge');
    expect(env.deviceType).toBe('ssh');
    expect(env.host).toBe('10.0.0.1');
    expect(env.username).toBe('admin');
    expect(env.port).toBe(22);
    expect(env.tmuxSession).toBe('ops');
    expect(env.gatewayOs).toBeNull();
    expect(env.gatewayShell).toBeNull();
    expect(env.term).toBeNull();
    expect(env.termProgram).toBeNull();
    expect(env.locale).toBeNull();
    expect(env.encoding).toBeNull();
  });

  test('ssh 缺省 host/port/username/session 映射为 null', () => {
    const env = collectAgentEnvironment(device({ type: 'ssh' }));
    expect(env.host).toBeNull();
    expect(env.username).toBeNull();
    expect(env.port).toBeNull();
    expect(env.tmuxSession).toBeNull();
    expect(env.deviceType).toBe('ssh');
  });

  test('local 设备采集入口主机 OS/shell/term/locale/encoding', () => {
    const env = collectAgentEnvironment(device({ name: 'this-mac', type: 'local' }));
    expect(env.deviceName).toBe('this-mac');
    expect(env.deviceType).toBe('local');
    expect(env.host).toBeNull();
    expect(env.gatewayOs).toBe(`${os.platform()} ${os.release()} (${os.arch()})`);
    expect(env.gatewayShell).toBe(process.env.SHELL ?? null);
    expect(env.term).toBe(process.env.TERM ?? null);
    expect(env.termProgram).toBe(process.env.TERM_PROGRAM ?? null);
    expect(env.locale).toBe(process.env.LANG ?? process.env.LC_ALL ?? null);
    expect(env.encoding).toBe('utf-8');
  });
});
