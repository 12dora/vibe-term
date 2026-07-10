// 设备表单纯逻辑：默认值、payload 构造与校验（local/ssh 四种 authMode）。

import type { CreateDeviceRequest, Device, UpdateDeviceRequest } from '@tmex/shared';

export type DeviceFormValues = {
  name: string;
  type: 'local' | 'ssh';
  host: string;
  port: number;
  username: string;
  sshConfigRef: string;
  session: string;
  defaultWorkingDir: string;
  authMode: CreateDeviceRequest['authMode'];
  password: string;
  privateKey: string;
  privateKeyPassphrase: string;
};

function normalizeText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function createDefaultFormValues(device?: Device): DeviceFormValues {
  if (!device) {
    return {
      name: '',
      type: 'local',
      host: '',
      port: 22,
      // SSH 字段预填预期默认值（与 placeholder 一致），减少新建 SSH 设备时的手填负担；
      // host 不预填（需用户填真实地址）；sshConfigRef 仅 configRef 模式用，默认留空。
      username: 'root',
      sshConfigRef: '',
      session: 'tmex',
      defaultWorkingDir: '',
      authMode: 'auto',
      password: '',
      privateKey: '',
      privateKeyPassphrase: '',
    };
  }

  return {
    name: device.name,
    type: device.type,
    host: device.host ?? '',
    port: device.port ?? 22,
    username: device.username ?? '',
    sshConfigRef: device.sshConfigRef ?? '',
    session: device.session ?? 'tmex',
    defaultWorkingDir: device.defaultWorkingDir ?? '',
    authMode: device.type === 'local' ? 'auto' : device.authMode,
    password: '',
    privateKey: '',
    privateKeyPassphrase: '',
  };
}

export function buildCreatePayload(values: DeviceFormValues): CreateDeviceRequest {
  if (values.type === 'local') {
    return {
      name: values.name.trim(),
      type: 'local',
      session: normalizeText(values.session) ?? 'tmex',
      defaultWorkingDir: normalizeText(values.defaultWorkingDir),
      authMode: 'auto',
    };
  }

  // host/port/username 经 validateDeviceForm 强校验非空，显式发送具体值；
  // sshConfigRef 仅 configRef 模式才有意义
  const payload: CreateDeviceRequest = {
    name: values.name.trim(),
    type: 'ssh',
    host: values.host.trim(),
    port: values.port,
    username: values.username.trim(),
    session: normalizeText(values.session) ?? 'tmex',
    defaultWorkingDir: normalizeText(values.defaultWorkingDir),
    authMode: values.authMode,
  };

  if (values.authMode === 'configRef') {
    payload.sshConfigRef = values.sshConfigRef.trim();
  }

  if (values.authMode === 'password') {
    payload.password = values.password;
  }

  if (values.authMode === 'key') {
    payload.privateKey = values.privateKey;
    payload.privateKeyPassphrase = values.privateKeyPassphrase || undefined;
  }

  return payload;
}

export function buildUpdatePayload(values: DeviceFormValues): UpdateDeviceRequest {
  if (values.type === 'local') {
    return {
      name: values.name.trim(),
      session: normalizeText(values.session) ?? 'tmex',
      defaultWorkingDir: normalizeText(values.defaultWorkingDir) ?? '',
      authMode: 'auto',
    };
  }

  // 编辑时 host/port/username 同为强校验必填，显式发送具体值；
  // 非 configRef 模式显式清空 sshConfigRef，顺带清理历史脏数据（避免残留引用劫持 host）
  const payload: UpdateDeviceRequest = {
    name: values.name.trim(),
    host: values.host.trim(),
    port: values.port,
    username: values.username.trim(),
    sshConfigRef: values.authMode === 'configRef' ? values.sshConfigRef.trim() : '',
    session: normalizeText(values.session) ?? 'tmex',
    defaultWorkingDir: normalizeText(values.defaultWorkingDir) ?? '',
    authMode: values.authMode,
  };

  if (values.authMode === 'password' && values.password) {
    payload.password = values.password;
  }

  if (values.authMode === 'key' && values.privateKey) {
    payload.privateKey = values.privateKey;
    payload.privateKeyPassphrase = values.privateKeyPassphrase || undefined;
  }

  return payload;
}

// 合法 SSH 端口：1–65535 的整数（清空输入会变成 NaN，视为非法）
export function isValidSshPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

// SSH 设备：host/端口/用户名在创建与编辑时均为强校验必填项；
// sshConfigRef 仅在认证方式为 configRef 时必填。
// 返回首个未通过校验的 i18n key，全部通过返回 null。
export function validateDeviceForm(values: DeviceFormValues): string | null {
  if (values.type !== 'ssh') {
    return null;
  }
  if (!values.host.trim()) {
    return 'validation.hostRequired';
  }
  if (!isValidSshPort(values.port)) {
    return 'validation.portRequired';
  }
  if (!values.username.trim()) {
    return 'validation.usernameRequired';
  }
  if (values.authMode === 'configRef' && !values.sshConfigRef.trim()) {
    return 'validation.sshConfigRequired';
  }
  return null;
}
