import { describe, expect, test } from 'bun:test';

import type { DeviceFormValues } from './device-form';
import { buildDevicePayload, resolveMutationErrorMessage } from './use-device-dialog-submit';

function formValues(overrides: Partial<DeviceFormValues> = {}): DeviceFormValues {
  return {
    name: '  box  ',
    type: 'ssh',
    host: ' 10.0.0.2 ',
    port: 2222,
    username: ' root ',
    sshConfigRef: ' prod-jump ',
    session: ' work ',
    defaultWorkingDir: ' /srv ',
    authMode: 'agent',
    password: '',
    privateKey: '',
    privateKeyPassphrase: '',
    ...overrides,
  };
}

describe('buildDevicePayload 创建模式', () => {
  test('local 设备只发送基础字段', () => {
    const result = buildDevicePayload(formValues({ type: 'local' }), 'create');
    expect(result).toEqual({
      mode: 'create',
      payload: {
        name: 'box',
        type: 'local',
        session: 'work',
        defaultWorkingDir: '/srv',
        authMode: 'auto',
      },
    });
  });

  test('local 设备留空 session/工作目录时回落默认值', () => {
    const result = buildDevicePayload(
      formValues({ type: 'local', session: '   ', defaultWorkingDir: '  ' }),
      'create'
    );
    expect(result.payload).toMatchObject({ session: 'tmex' });
    expect(result.payload.defaultWorkingDir).toBeUndefined();
  });

  test('ssh + agent 不携带任何凭据字段', () => {
    const result = buildDevicePayload(formValues(), 'create');
    expect(result).toEqual({
      mode: 'create',
      payload: {
        name: 'box',
        type: 'ssh',
        host: '10.0.0.2',
        port: 2222,
        username: 'root',
        session: 'work',
        defaultWorkingDir: '/srv',
        authMode: 'agent',
      },
    });
  });

  test('ssh + password 携带原始密码（不 trim）', () => {
    const result = buildDevicePayload(
      formValues({ authMode: 'password', password: ' pa ss ' }),
      'create'
    );
    expect(result.payload).toMatchObject({ authMode: 'password', password: ' pa ss ' });
    expect('sshConfigRef' in result.payload).toBe(false);
  });

  test('ssh + key 携带私钥，空 passphrase 归一为 undefined', () => {
    const result = buildDevicePayload(
      formValues({ authMode: 'key', privateKey: 'KEY', privateKeyPassphrase: '' }),
      'create'
    );
    expect(result.payload).toMatchObject({ authMode: 'key', privateKey: 'KEY' });
    expect(result.payload.privateKeyPassphrase).toBeUndefined();
  });

  test('ssh + key 携带非空 passphrase', () => {
    const result = buildDevicePayload(
      formValues({ authMode: 'key', privateKey: 'KEY', privateKeyPassphrase: 'pp' }),
      'create'
    );
    expect(result.payload).toMatchObject({ privateKey: 'KEY', privateKeyPassphrase: 'pp' });
  });

  test('ssh + configRef 携带 trim 后的引用名', () => {
    const result = buildDevicePayload(formValues({ authMode: 'configRef' }), 'create');
    expect(result.payload).toMatchObject({ authMode: 'configRef', sshConfigRef: 'prod-jump' });
  });
});

describe('buildDevicePayload 编辑模式', () => {
  test('local 设备不发送 type，工作目录留空发送空串', () => {
    const result = buildDevicePayload(
      formValues({ type: 'local', defaultWorkingDir: '  ' }),
      'edit'
    );
    expect(result).toEqual({
      mode: 'edit',
      payload: { name: 'box', session: 'work', defaultWorkingDir: '', authMode: 'auto' },
    });
  });

  test('ssh + configRef 编辑时保留 SSH Config 引用（不得被清空）', () => {
    const result = buildDevicePayload(formValues({ authMode: 'configRef' }), 'edit');
    expect(result.payload).toMatchObject({ authMode: 'configRef', sshConfigRef: 'prod-jump' });
  });

  test('ssh 非 configRef 模式显式清空 sshConfigRef', () => {
    for (const authMode of ['agent', 'password', 'key'] as const) {
      const result = buildDevicePayload(formValues({ authMode }), 'edit');
      expect(result.payload).toMatchObject({ authMode, sshConfigRef: '' });
    }
  });

  test('ssh + password 留空时不覆盖已存凭据', () => {
    const result = buildDevicePayload(formValues({ authMode: 'password', password: '' }), 'edit');
    expect('password' in result.payload).toBe(false);
  });

  test('ssh + password 填写时提交新密码', () => {
    const result = buildDevicePayload(
      formValues({ authMode: 'password', password: 'new-pass' }),
      'edit'
    );
    expect(result.payload).toMatchObject({ password: 'new-pass' });
  });

  test('ssh + key 留空私钥时不覆盖已存私钥（passphrase 同样不发送）', () => {
    const result = buildDevicePayload(
      formValues({ authMode: 'key', privateKey: '', privateKeyPassphrase: 'pp' }),
      'edit'
    );
    expect('privateKey' in result.payload).toBe(false);
    expect('privateKeyPassphrase' in result.payload).toBe(false);
  });

  test('ssh + key 填写私钥时一并提交 passphrase', () => {
    const result = buildDevicePayload(
      formValues({ authMode: 'key', privateKey: 'KEY', privateKeyPassphrase: 'pp' }),
      'edit'
    );
    expect(result.payload).toMatchObject({ privateKey: 'KEY', privateKeyPassphrase: 'pp' });
  });

  test('ssh 连接字段始终显式提交 trim 后的值', () => {
    const result = buildDevicePayload(formValues(), 'edit');
    expect(result.payload).toMatchObject({ host: '10.0.0.2', port: 2222, username: 'root' });
  });
});

describe('resolveMutationErrorMessage', () => {
  test('Error 取 message，其他取回落文案', () => {
    expect(resolveMutationErrorMessage(new Error('boom'), 'fallback')).toBe('boom');
    expect(resolveMutationErrorMessage('boom', 'fallback')).toBe('fallback');
    expect(resolveMutationErrorMessage(undefined, 'fallback')).toBe('fallback');
  });
});
