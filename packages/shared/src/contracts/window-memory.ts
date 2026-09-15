// 窗口内存限额（systemd pane scope）设置与 CLI/HTTP 读取契约；网关与前端、CLI 共用。

export interface WindowMemorySettings {
  enabled: boolean;
  /** MemoryHigh，MiB；0 = 不设置该属性。 */
  memoryHighMb: number;
  /** MemoryMax，MiB；0 = 不设置该属性。 */
  memoryMaxMb: number;
  /** MemorySwapMax，MiB；0 = 不设置该属性。 */
  memorySwapMaxMb: number;
  /** 采样周期（秒）。 */
  sampleIntervalSec: number;
}

export const WINDOW_MEMORY_SETTINGS_DEFAULTS: WindowMemorySettings = {
  enabled: true,
  memoryHighMb: 8192,
  memoryMaxMb: 12288,
  memorySwapMaxMb: 4096,
  sampleIntervalSec: 5,
};

export const WINDOW_MEMORY_MB_MAX = 1_048_576;
export const WINDOW_MEMORY_INTERVAL_MIN_SEC = 2;
export const WINDOW_MEMORY_INTERVAL_MAX_SEC = 60;

export interface WindowMemorySample {
  windowId: string;
  current: number;
  high: number;
  max: number;
  swapMax: number;
  oomKills: number;
  oomFlag: boolean;
  panes: number;
  sampledAt: number;
}

export interface SessionsMemoryWindow extends WindowMemorySample {
  windowName: string;
  scopes: string[];
}

export interface SessionsMemoryDevice {
  deviceId: string;
  deviceName: string;
  supported: boolean;
  windows: SessionsMemoryWindow[];
}

export interface SessionsMemoryResponse {
  devices: SessionsMemoryDevice[];
}
