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

/**
 * 读数来源。`cgroup` = pane 的 `tmux-spawn-*.scope`（tmux ≥ 3.6 + systemd + cgroup v2），限额可用；
 * `rss` = 宿主没有 pane scope，退回按 pane 进程树 RSS 合计，限额**不可用**（不是「未设限」）。
 */
export type WindowMemorySource = 'cgroup' | 'rss';

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
  source: WindowMemorySource;
}

export interface SessionsMemoryWindow extends WindowMemorySample {
  windowName: string;
  scopes: string[];
}

export interface SessionsMemoryDevice {
  deviceId: string;
  deviceName: string;
  connected: boolean;
  /** 能否量到内存（量不到就不发帧、不渲染徽标）。 */
  supported: boolean;
  /** 宿主能否按窗口限额；`false` 时限额设置写得进去但不会生效。null = 尚未判定。 */
  limitsSupported: boolean | null;
  windows: SessionsMemoryWindow[];
}

export interface SessionsMemoryResponse {
  devices: SessionsMemoryDevice[];
}
