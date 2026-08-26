// 设备（本地 / SSH）契约

export type DeviceType = 'local' | 'ssh';
export type AuthMode = 'password' | 'key' | 'agent' | 'configRef' | 'auto';

export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  host?: string;
  port?: number;
  username?: string;
  sshConfigRef?: string;
  session?: string;
  authMode: AuthMode;
  passwordEnc?: string;
  privateKeyEnc?: string;
  privateKeyPassphraseEnc?: string;
  defaultWorkingDir?: string;
  // device tree 中的自定义显示顺序，升序；越小越靠前
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceRuntimeStatus {
  deviceId: string;
  lastSeenAt: string | null;
  tmuxAvailable: boolean;
  lastError: string | null;
  lastErrorType: string | null;
}

export interface CreateDeviceRequest {
  name: string;
  type: DeviceType;
  host?: string;
  port?: number;
  username?: string;
  sshConfigRef?: string;
  session?: string;
  defaultWorkingDir?: string;
  authMode: AuthMode;
  password?: string;
  privateKey?: string;
  privateKeyPassphrase?: string;
}

export interface UpdateDeviceRequest {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  sshConfigRef?: string;
  session?: string;
  defaultWorkingDir?: string;
  authMode?: AuthMode;
  password?: string;
  privateKey?: string;
  privateKeyPassphrase?: string;
}

export interface TestConnectionResult {
  success: boolean;
  tmuxAvailable: boolean;
  phase: 'connect' | 'bootstrap' | 'ready';
  errorType?: string;
  message?: string;
  rawMessage?: string;
}
