// 设备（本地 / SSH）契约

export type DeviceType = 'local' | 'ssh';
export type AuthMode = 'password' | 'key' | 'agent' | 'configRef' | 'auto';

const DEVICE_CONNECTION_ERROR_TYPES = [
  'ssh_config_ref_not_supported',
  'agent_unavailable',
  'agent_no_identity',
  'auth_failed',
  'network_unreachable',
  'connection_refused',
  'timeout',
  'host_not_found',
  'handshake_failed',
  'tmux_unavailable',
  'tmux_busy',
  'connection_closed',
  'unknown',
] as const;

export type DeviceConnectionErrorType = (typeof DEVICE_CONNECTION_ERROR_TYPES)[number];

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
  errorType?: DeviceConnectionErrorType;
  message?: string;
  rawMessage?: string;
}
