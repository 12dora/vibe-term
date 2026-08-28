import { describe, expect, test } from 'bun:test';
import type { Device } from '@tmex/shared';
import { t } from '../i18n';
import {
  nextDevicePushAction,
  parseDeviceUpdateFields,
  shouldReconnectPushSupervisor,
} from './device-patch';

function sampleDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: 'dev-1',
    name: 'box',
    type: 'ssh',
    host: 'example.test',
    port: 22,
    username: 'root',
    sshConfigRef: 'work',
    session: 'tmex',
    authMode: 'password',
    passwordEnc: 'pw-enc',
    privateKeyEnc: 'key-enc',
    privateKeyPassphraseEnc: 'pass-enc',
    defaultWorkingDir: '/home',
    sortOrder: 0,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const COMPARE_CASES: Array<{
  key: keyof Device;
  changed: Partial<Device>;
}> = [
  { key: 'type', changed: { type: 'local' } },
  { key: 'host', changed: { host: 'other.test' } },
  { key: 'port', changed: { port: 2222 } },
  { key: 'username', changed: { username: 'ubuntu' } },
  { key: 'sshConfigRef', changed: { sshConfigRef: 'home' } },
  { key: 'session', changed: { session: 'other' } },
  { key: 'authMode', changed: { authMode: 'key' } },
];

const SECRET_KEYS = ['passwordEnc', 'privateKeyEnc', 'privateKeyPassphraseEnc'] as const;

describe('shouldReconnectPushSupervisor', () => {
  test('空 patch 不重连', () => {
    expect(shouldReconnectPushSupervisor(sampleDevice(), {})).toBe(false);
  });

  test('name / defaultWorkingDir 变化不重连', () => {
    const existing = sampleDevice();
    expect(shouldReconnectPushSupervisor(existing, { name: 'renamed' })).toBe(false);
    expect(shouldReconnectPushSupervisor(existing, { defaultWorkingDir: '/tmp' })).toBe(false);
  });

  for (const { key, changed } of COMPARE_CASES) {
    test(`${key} 相同不重连，变化则重连`, () => {
      const existing = sampleDevice();
      expect(shouldReconnectPushSupervisor(existing, { [key]: existing[key] })).toBe(false);
      expect(shouldReconnectPushSupervisor(existing, changed)).toBe(true);
    });
  }

  for (const key of SECRET_KEYS) {
    test(`${key} 只要出现就重连（含同值）`, () => {
      const existing = sampleDevice();
      expect(shouldReconnectPushSupervisor(existing, { [key]: existing[key] })).toBe(true);
      expect(shouldReconnectPushSupervisor(existing, { [key]: 'new-enc' })).toBe(true);
    });
  }
});

describe('nextDevicePushAction', () => {
  test('连接字段变化 → reconnect', () => {
    expect(nextDevicePushAction(sampleDevice(), { host: 'other.test' })).toEqual({
      type: 'reconnect',
    });
  });

  test('仅 defaultWorkingDir 变化 → workingDir', () => {
    expect(nextDevicePushAction(sampleDevice(), { defaultWorkingDir: '/tmp' })).toEqual({
      type: 'workingDir',
      dir: '/tmp',
    });
  });

  test('defaultWorkingDir 被清空（undefined）不触发 workingDir', () => {
    expect(nextDevicePushAction(sampleDevice(), { defaultWorkingDir: undefined })).toEqual({
      type: 'none',
    });
  });

  test('同值 defaultWorkingDir → none', () => {
    const existing = sampleDevice();
    expect(
      nextDevicePushAction(existing, { defaultWorkingDir: existing.defaultWorkingDir })
    ).toEqual({ type: 'none' });
  });

  test('仅改 name → none', () => {
    expect(nextDevicePushAction(sampleDevice(), { name: 'renamed' })).toEqual({ type: 'none' });
  });
});

describe('parseDeviceUpdateFields', () => {
  test('空 body → 空 fields', () => {
    expect(parseDeviceUpdateFields({})).toEqual({ ok: true, fields: {} });
  });

  test('透传声明式字段', () => {
    expect(
      parseDeviceUpdateFields({
        name: 'n',
        host: 'h',
        port: 2222,
        username: 'u',
        sshConfigRef: 'r',
        session: 's',
        authMode: 'agent',
        password: 'pw',
        privateKey: 'key',
        privateKeyPassphrase: 'ph',
      })
    ).toEqual({
      ok: true,
      fields: {
        name: 'n',
        host: 'h',
        port: 2222,
        username: 'u',
        sshConfigRef: 'r',
        session: 's',
        authMode: 'agent',
        password: 'pw',
        privateKey: 'key',
        privateKeyPassphrase: 'ph',
      },
    });
  });

  test('defaultWorkingDir trim，空白收成 undefined', () => {
    expect(parseDeviceUpdateFields({ defaultWorkingDir: '  /opt  ' })).toEqual({
      ok: true,
      fields: { defaultWorkingDir: '/opt' },
    });
    expect(parseDeviceUpdateFields({ defaultWorkingDir: '   ' })).toEqual({
      ok: true,
      fields: { defaultWorkingDir: undefined },
    });
  });

  test('type 不在 UpdateDeviceRequest 中，忽略', () => {
    const parsed = parseDeviceUpdateFields({ type: 'local', name: 'n' });
    expect(parsed).toEqual({ ok: true, fields: { name: 'n' } });
  });

  const invalidCases: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: 'name 非字符串', body: { name: 1 } },
    { name: 'host 非字符串', body: { host: 1 } },
    { name: 'port 非整数', body: { port: 22.5 } },
    { name: 'username 非字符串', body: { username: true } },
    { name: 'sshConfigRef 非字符串', body: { sshConfigRef: 1 } },
    { name: 'session 非字符串', body: { session: 1 } },
    { name: 'defaultWorkingDir 非字符串', body: { defaultWorkingDir: 1 } },
    { name: 'authMode 非法', body: { authMode: 'token' } },
    { name: 'password 非字符串', body: { password: 1 } },
    { name: 'privateKey 非字符串', body: { privateKey: 1 } },
    { name: 'privateKeyPassphrase 非字符串', body: { privateKeyPassphrase: 1 } },
  ];

  for (const { name, body } of invalidCases) {
    test(name, () => {
      expect(parseDeviceUpdateFields(body)).toEqual({
        ok: false,
        error: t('apiError.invalidRequest'),
      });
    });
  }
});
