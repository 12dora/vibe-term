import { afterEach, describe, expect, test } from 'bun:test';
import os from 'node:os';
import type { Device } from '@tmex/shared';
import { collectAgentEnvironment } from './environment';

const now = '2026-06-13T08:00:00.000Z';

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: 'dev-1',
    name: 'lab',
    type: 'ssh',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const ENV_KEYS = ['SHELL', 'TERM', 'TERM_PROGRAM', 'LANG', 'LC_ALL'] as const;

function snapshotEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
  return {
    SHELL: process.env.SHELL,
    TERM: process.env.TERM,
    TERM_PROGRAM: process.env.TERM_PROGRAM,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
  };
}

function unsetEnv(key: string): void {
  Reflect.deleteProperty(process.env, key);
}

function restoreEnv(snapshot: Record<(typeof ENV_KEYS)[number], string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      unsetEnv(key);
    } else {
      process.env[key] = value;
    }
  }
}

function expectedTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

describe('collectAgentEnvironment', () => {
  const envSnapshot = snapshotEnv();

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  test('device 为 null 时设备字段与入口主机字段均为 null', () => {
    const info = collectAgentEnvironment(null);
    expect(info.deviceName).toBeNull();
    expect(info.deviceType).toBeNull();
    expect(info.host).toBeNull();
    expect(info.username).toBeNull();
    expect(info.port).toBeNull();
    expect(info.tmuxSession).toBeNull();
    expect(info.gatewayOs).toBeNull();
    expect(info.gatewayShell).toBeNull();
    expect(info.term).toBeNull();
    expect(info.termProgram).toBeNull();
    expect(info.locale).toBeNull();
    expect(info.encoding).toBeNull();
    expect(info.timezone).toBe(expectedTimezone());
    expect(info.nowIso).toMatch(/^\d{4}-\d{2}-\d{2}T.+/);
    expect(Math.abs(Date.parse(info.nowIso) - Date.now())).toBeLessThan(2000);
  });

  test('ssh 设备只采集接入参数，不读入口主机环境', () => {
    process.env.SHELL = '/bin/zsh';
    process.env.TERM = 'xterm-256color';
    process.env.TERM_PROGRAM = 'iTerm.app';
    process.env.LANG = 'zh_CN.UTF-8';

    const info = collectAgentEnvironment(
      makeDevice({
        name: 'edge-router',
        type: 'ssh',
        host: '10.0.0.1',
        username: 'admin',
        port: 22,
        session: 'ops',
      })
    );

    expect(info.deviceName).toBe('edge-router');
    expect(info.deviceType).toBe('ssh');
    expect(info.host).toBe('10.0.0.1');
    expect(info.username).toBe('admin');
    expect(info.port).toBe(22);
    expect(info.tmuxSession).toBe('ops');
    expect(info.gatewayOs).toBeNull();
    expect(info.gatewayShell).toBeNull();
    expect(info.term).toBeNull();
    expect(info.termProgram).toBeNull();
    expect(info.locale).toBeNull();
    expect(info.encoding).toBeNull();
  });

  test('ssh 设备缺 host/username/port/session 时对应字段为 null', () => {
    const info = collectAgentEnvironment(makeDevice({ type: 'ssh', name: 'partial' }));
    expect(info.deviceName).toBe('partial');
    expect(info.deviceType).toBe('ssh');
    expect(info.host).toBeNull();
    expect(info.username).toBeNull();
    expect(info.port).toBeNull();
    expect(info.tmuxSession).toBeNull();
  });

  test('local 设备采集入口主机 OS/shell/term/locale/encoding', () => {
    process.env.SHELL = '/bin/bash';
    process.env.TERM = 'screen-256color';
    process.env.TERM_PROGRAM = 'tmux';
    process.env.LANG = 'en_US.UTF-8';
    unsetEnv('LC_ALL');

    const info = collectAgentEnvironment(makeDevice({ type: 'local', name: 'macbook' }));

    expect(info.deviceName).toBe('macbook');
    expect(info.deviceType).toBe('local');
    expect(info.gatewayOs).toBe(`${os.platform()} ${os.release()} (${os.arch()})`);
    expect(info.gatewayShell).toBe('/bin/bash');
    expect(info.term).toBe('screen-256color');
    expect(info.termProgram).toBe('tmux');
    expect(info.locale).toBe('en_US.UTF-8');
    expect(info.encoding).toBe('utf-8');
  });

  test('local 设备 LANG 缺失时回退 LC_ALL', () => {
    unsetEnv('LANG');
    process.env.LC_ALL = 'C.UTF-8';
    const info = collectAgentEnvironment(makeDevice({ type: 'local' }));
    expect(info.locale).toBe('C.UTF-8');
  });

  test('local 设备环境变量缺失时对应字段为 null', () => {
    for (const key of ENV_KEYS) {
      unsetEnv(key);
    }
    const info = collectAgentEnvironment(makeDevice({ type: 'local' }));
    expect(info.gatewayShell).toBeNull();
    expect(info.term).toBeNull();
    expect(info.termProgram).toBeNull();
    expect(info.locale).toBeNull();
    expect(info.encoding).toBe('utf-8');
  });
});
