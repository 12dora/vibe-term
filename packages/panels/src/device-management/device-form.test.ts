// 设备表单纯逻辑：默认值归一（authMode auto → agent）、create/update payload 的字段裁剪与校验。

import { describe, expect, test } from 'bun:test';
import type { Device } from '@tmex/shared';
import {
  type DeviceFormValues,
  buildCreatePayload,
  buildUpdatePayload,
  createDefaultFormValues,
  isValidSshPort,
  normalizeSshAuthMode,
  validateDeviceForm,
} from './device-form';

const BASE_DEVICE: Device = {
  id: 'dev-1',
  name: '书房',
  type: 'local',
  authMode: 'auto',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function sshDevice(overrides: Partial<Device> = {}): Device {
  return {
    ...BASE_DEVICE,
    type: 'ssh',
    host: '10.0.0.2',
    port: 2222,
    username: 'root',
    authMode: 'agent',
    ...overrides,
  };
}

function sshValues(overrides: Partial<DeviceFormValues> = {}): DeviceFormValues {
  return {
    name: '  书房  ',
    type: 'ssh',
    host: '  10.0.0.2  ',
    port: 2222,
    username: '  root  ',
    sshConfigRef: '  prod  ',
    session: '  tmex  ',
    defaultWorkingDir: '  /srv  ',
    authMode: 'agent',
    password: 'pw',
    privateKey: 'KEY',
    privateKeyPassphrase: 'pass',
    ...overrides,
  };
}

describe('normalizeSshAuthMode', () => {
  test('auto / 缺失都归一为 agent', () => {
    expect(normalizeSshAuthMode('auto')).toBe('agent');
    expect(normalizeSshAuthMode(undefined)).toBe('agent');
    expect(normalizeSshAuthMode(null)).toBe('agent');
  });

  test('其余模式原样保留', () => {
    expect(normalizeSshAuthMode('password')).toBe('password');
    expect(normalizeSshAuthMode('key')).toBe('key');
    expect(normalizeSshAuthMode('configRef')).toBe('configRef');
  });
});

describe('createDefaultFormValues', () => {
  test('新建默认是本地设备', () => {
    const values = createDefaultFormValues();
    expect(values.type).toBe('local');
    expect(values.authMode).toBe('auto');
    expect(values.session).toBe('tmex');
  });

  test('编辑 SSH 设备时 authMode=auto 归一为 agent，保证下拉有匹配项', () => {
    expect(createDefaultFormValues(sshDevice({ authMode: 'auto' })).authMode).toBe('agent');
  });

  test('编辑 SSH 设备保留显式的认证方式', () => {
    expect(createDefaultFormValues(sshDevice({ authMode: 'configRef' })).authMode).toBe(
      'configRef'
    );
  });

  test('本地设备的 authMode 永远是 auto（历史脏数据也归一）', () => {
    expect(createDefaultFormValues(BASE_DEVICE).authMode).toBe('auto');
    expect(createDefaultFormValues({ ...BASE_DEVICE, authMode: 'password' }).authMode).toBe('auto');
  });
});

describe('buildCreatePayload', () => {
  test('本地设备只发基础字段，不带任何 SSH 连接/认证字段', () => {
    const payload = buildCreatePayload(sshValues({ type: 'local' }));
    expect(payload).toEqual({
      name: '书房',
      type: 'local',
      session: 'tmex',
      defaultWorkingDir: '/srv',
      authMode: 'auto',
    });
  });

  test('SSH + agent 发连接字段，不带密码/私钥/configRef', () => {
    const payload = buildCreatePayload(sshValues());
    expect(payload.type).toBe('ssh');
    expect(payload.host).toBe('10.0.0.2');
    expect(payload.port).toBe(2222);
    expect(payload.username).toBe('root');
    expect(payload.password).toBeUndefined();
    expect(payload.privateKey).toBeUndefined();
    expect(payload.sshConfigRef).toBeUndefined();
  });

  test('按认证方式只带该模式需要的密钥字段', () => {
    expect(buildCreatePayload(sshValues({ authMode: 'password' })).password).toBe('pw');
    expect(buildCreatePayload(sshValues({ authMode: 'key' })).privateKey).toBe('KEY');
    expect(buildCreatePayload(sshValues({ authMode: 'key' })).privateKeyPassphrase).toBe('pass');
    expect(buildCreatePayload(sshValues({ authMode: 'configRef' })).sshConfigRef).toBe('prod');
  });
});

describe('buildUpdatePayload', () => {
  test('本地设备的更新 payload 不含 type（类型创建后不可改）', () => {
    const payload = buildUpdatePayload(sshValues({ type: 'local' }));
    expect(payload).not.toHaveProperty('type');
    expect(payload).toEqual({
      name: '书房',
      session: 'tmex',
      defaultWorkingDir: '/srv',
      authMode: 'auto',
    });
  });

  test('SSH 设备的更新 payload 同样不含 type', () => {
    const payload = buildUpdatePayload(sshValues());
    expect(payload).not.toHaveProperty('type');
    expect(payload.host).toBe('10.0.0.2');
    expect(payload.authMode).toBe('agent');
  });

  test('非 configRef 模式显式清空 sshConfigRef，清理历史脏数据', () => {
    expect(buildUpdatePayload(sshValues({ authMode: 'agent' })).sshConfigRef).toBe('');
    expect(buildUpdatePayload(sshValues({ authMode: 'configRef' })).sshConfigRef).toBe('prod');
  });

  test('密码/私钥留空表示不改，不进 payload', () => {
    const payload = buildUpdatePayload(sshValues({ authMode: 'password', password: '' }));
    expect(payload.password).toBeUndefined();
    const keyPayload = buildUpdatePayload(sshValues({ authMode: 'key', privateKey: '' }));
    expect(keyPayload.privateKey).toBeUndefined();
  });
});

describe('validateDeviceForm', () => {
  test('本地设备无需校验 SSH 字段', () => {
    expect(validateDeviceForm(sshValues({ type: 'local', host: '' }))).toBeNull();
  });

  test('SSH 设备缺 host/port/username/configRef 时返回对应 i18n key', () => {
    expect(validateDeviceForm(sshValues({ host: '   ' }))).toBe('validation.hostRequired');
    expect(validateDeviceForm(sshValues({ port: Number.NaN }))).toBe('validation.portRequired');
    expect(validateDeviceForm(sshValues({ username: '   ' }))).toBe('validation.usernameRequired');
    expect(validateDeviceForm(sshValues({ authMode: 'configRef', sshConfigRef: ' ' }))).toBe(
      'validation.sshConfigRequired'
    );
  });

  test('端口边界', () => {
    expect(isValidSshPort(0)).toBe(false);
    expect(isValidSshPort(1)).toBe(true);
    expect(isValidSshPort(65535)).toBe(true);
    expect(isValidSshPort(65536)).toBe(false);
  });
});
