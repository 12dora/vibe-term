import { describe, expect, test } from 'bun:test';
import {
  type DeviceFormValues,
  applyDeviceType,
  buildCreatePayload,
  buildUpdatePayload,
  createDefaultFormValues,
  isValidSshPort,
  parseSshPortInput,
  validateDeviceForm,
} from './device-form';

const sshValues = (overrides: Partial<DeviceFormValues> = {}): DeviceFormValues => ({
  ...createDefaultFormValues(),
  name: 'box',
  type: 'ssh',
  host: 'example.com',
  authMode: 'agent',
  ...overrides,
});

describe('applyDeviceType', () => {
  const cases: Array<{
    name: string;
    from: DeviceFormValues['authMode'];
    to: DeviceFormValues['type'];
    expected: DeviceFormValues['authMode'];
  }> = [
    { name: 'ssh password -> local forces auto', from: 'password', to: 'local', expected: 'auto' },
    { name: 'ssh agent -> local forces auto', from: 'agent', to: 'local', expected: 'auto' },
    { name: 'local auto -> ssh falls back to agent', from: 'auto', to: 'ssh', expected: 'agent' },
    {
      name: 'ssh password -> ssh keeps password',
      from: 'password',
      to: 'ssh',
      expected: 'password',
    },
    { name: 'ssh key -> ssh keeps key', from: 'key', to: 'ssh', expected: 'key' },
    {
      name: 'ssh configRef -> ssh keeps configRef',
      from: 'configRef',
      to: 'ssh',
      expected: 'configRef',
    },
  ];

  for (const { name, from, to, expected } of cases) {
    test(name, () => {
      const next = applyDeviceType(sshValues({ authMode: from }), to);
      expect(next.type).toBe(to);
      expect(next.authMode).toBe(expected);
    });
  }

  test('keeps every other field untouched', () => {
    const values = sshValues({ session: 'work', defaultWorkingDir: '/srv', password: 'secret' });
    const next = applyDeviceType(values, 'local');
    expect({ ...next, type: values.type, authMode: values.authMode }).toEqual(values);
  });
});

describe('parseSshPortInput', () => {
  test('empty input becomes NaN and fails port validation', () => {
    const port = parseSshPortInput('');
    expect(Number.isNaN(port)).toBe(true);
    expect(isValidSshPort(port)).toBe(false);
  });

  test('parses a decimal port', () => {
    expect(parseSshPortInput('2222')).toBe(2222);
  });

  test('parses the leading integer of a partially numeric value', () => {
    expect(parseSshPortInput('22abc')).toBe(22);
  });
});

describe('validateDeviceForm', () => {
  test('local devices skip ssh validation', () => {
    expect(validateDeviceForm(createDefaultFormValues())).toBeNull();
  });

  test('reports the first failing ssh field', () => {
    expect(validateDeviceForm(sshValues({ host: '  ' }))).toBe('validation.hostRequired');
    expect(validateDeviceForm(sshValues({ port: Number.NaN }))).toBe('validation.portRequired');
    expect(validateDeviceForm(sshValues({ username: '' }))).toBe('validation.usernameRequired');
    expect(validateDeviceForm(sshValues({ authMode: 'configRef' }))).toBe(
      'validation.sshConfigRequired'
    );
  });

  test('accepts a complete ssh form', () => {
    expect(validateDeviceForm(sshValues())).toBeNull();
  });
});

describe('payload construction per auth mode', () => {
  test('local create drops ssh fields and pins auto', () => {
    expect(buildCreatePayload(sshValues({ type: 'local', session: ' ' }))).toEqual({
      name: 'box',
      type: 'local',
      session: 'tmex',
      defaultWorkingDir: undefined,
      authMode: 'auto',
    });
  });

  test('configRef create sends the trimmed reference only', () => {
    const payload = buildCreatePayload(sshValues({ authMode: 'configRef', sshConfigRef: ' web ' }));
    expect(payload.sshConfigRef).toBe('web');
    expect(payload.password).toBeUndefined();
    expect(payload.privateKey).toBeUndefined();
  });

  test('key create sends the key and omits an empty passphrase', () => {
    const payload = buildCreatePayload(sshValues({ authMode: 'key', privateKey: 'PEM' }));
    expect(payload.privateKey).toBe('PEM');
    expect(payload.privateKeyPassphrase).toBeUndefined();
  });

  test('update clears sshConfigRef outside configRef mode', () => {
    const payload = buildUpdatePayload(sshValues({ authMode: 'agent', sshConfigRef: 'stale' }));
    expect(payload.sshConfigRef).toBe('');
  });

  test('update omits blank secrets so stored credentials survive', () => {
    expect(buildUpdatePayload(sshValues({ authMode: 'password' })).password).toBeUndefined();
    expect(buildUpdatePayload(sshValues({ authMode: 'key' })).privateKey).toBeUndefined();
  });
});
