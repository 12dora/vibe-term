import { afterEach, describe, expect, test } from 'bun:test';
import os from 'node:os';
import type { Device } from '@tmex/shared';
import {
  AGENT_ENV_FIELD_KEYS,
  AGENT_ENV_RESOLVERS,
  resolveEncoding,
  resolveGatewayOs,
  resolveLocale,
  resolveTimezone,
} from './environment-fields';

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

function unsetEnv(key: string): void {
  Reflect.deleteProperty(process.env, key);
}

function restoreEnvKey(key: string, value: string | undefined): void {
  if (value === undefined) unsetEnv(key);
  else process.env[key] = value;
}

describe('environment field resolvers', () => {
  const lang = process.env.LANG;
  const lcAll = process.env.LC_ALL;

  afterEach(() => {
    restoreEnvKey('LANG', lang);
    restoreEnvKey('LC_ALL', lcAll);
  });

  test('resolveTimezone 返回 Intl 时区或 UTC', () => {
    let expected = 'UTC';
    try {
      expected = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    } catch {
      expected = 'UTC';
    }
    expect(resolveTimezone()).toBe(expected);
  });

  test('resolveGatewayOs 仅 local 返回 platform/release/arch', () => {
    expect(resolveGatewayOs(false)).toBeNull();
    expect(resolveGatewayOs(true)).toBe(`${os.platform()} ${os.release()} (${os.arch()})`);
  });

  test('resolveEncoding 仅 local 为 utf-8', () => {
    expect(resolveEncoding(false)).toBeNull();
    expect(resolveEncoding(true)).toBe('utf-8');
  });

  test('resolveLocale 非 local 为 null，local 优先 LANG 再 LC_ALL', () => {
    process.env.LANG = 'zh_CN.UTF-8';
    process.env.LC_ALL = 'C';
    expect(resolveLocale(false)).toBeNull();
    expect(resolveLocale(true)).toBe('zh_CN.UTF-8');
    unsetEnv('LANG');
    expect(resolveLocale(true)).toBe('C');
    unsetEnv('LC_ALL');
    expect(resolveLocale(true)).toBeNull();
  });

  test('resolver 表覆盖 AgentEnvironmentInfo 全部字段', () => {
    expect(Object.keys(AGENT_ENV_RESOLVERS).sort()).toEqual([...AGENT_ENV_FIELD_KEYS].sort());
  });

  test('device 字段 resolver 对缺失输入返回 null', () => {
    const empty = { device: null, isLocal: false };
    expect(AGENT_ENV_RESOLVERS.deviceName(empty)).toBeNull();
    expect(AGENT_ENV_RESOLVERS.host(empty)).toBeNull();
    expect(AGENT_ENV_RESOLVERS.port(empty)).toBeNull();

    const partial = { device: makeDevice({ name: 'only-name' }), isLocal: false };
    expect(AGENT_ENV_RESOLVERS.deviceName(partial)).toBe('only-name');
    expect(AGENT_ENV_RESOLVERS.host(partial)).toBeNull();
    expect(AGENT_ENV_RESOLVERS.username(partial)).toBeNull();
    expect(AGENT_ENV_RESOLVERS.tmuxSession(partial)).toBeNull();
  });
});
