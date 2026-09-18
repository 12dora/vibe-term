// 窗口内存（systemd tmux-spawn pane scope）跟踪器的共享接口：tmux-client 侧实现采样 / 限额 / stop scope，
// 网关侧（设置、持久化 OOM 标记、WS 广播、HTTP）只依赖这里的类型。

import type { WindowMemorySettings } from '@vibeterm/shared';

/**
 * 单个 pane 读数的来源。`cgroup` = pane 落在 `tmux-spawn-*.scope` 里（可限额）；
 * `rss` = 宿主没有 pane scope（tmux < 3.6 / 未编 systemd / macOS），退回进程树 RSS 合计；
 * `none` = 连 RSS 都取不到（进程已退出、`ps` 不可用）。
 */
export type PaneMemorySource = 'cgroup' | 'rss' | 'none';

export interface HostShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** 在 tmux 所在宿主上执行一段 POSIX sh 脚本（本地 `sh -c`，SSH 设备走远端 shell）。 */
export interface HostShellRunner {
  runHostShell(
    script: string,
    opts?: { timeoutMs?: number; maxOutputBytes?: number }
  ): Promise<HostShellResult>;
}

export interface PaneScopeSample {
  paneId: string;
  pid: number;
  /** `tmux-spawn-*.scope`，pane 不在 scope 里时为 null。 */
  scope: string | null;
  current: number;
  high: number;
  max: number;
  swapMax: number;
  oomKills: number;
  /** memory.high 已不是 max（限额已应用）。 */
  managed: boolean;
  source: PaneMemorySource;
}

export interface WindowMemoryAggregate {
  windowId: string;
  windowName: string;
  panes: number;
  scopes: string[];
  current: number;
  high: number;
  max: number;
  swapMax: number;
  oomKills: number;
  oomFlag: boolean;
  sampledAt: number;
  /** 窗口口径：有样本的 pane 全是 cgroup 才是 cgroup；有一个走 RSS 就是 rss；全 none 的窗口不进结果。 */
  source: PaneMemorySource;
}

export interface WindowOomKillEvent {
  deviceId: string;
  windowId: string;
  paneId: string;
  scope: string;
  oomKills: number;
  current: number;
  high: number;
  max: number;
}

/** 持久化的 OOM 粘性标记（网关侧实现，gateway_kv JSON），按 deviceId+windowId 记。 */
export interface WindowOomMarkStore {
  has(deviceId: string, windowId: string): boolean;
  mark(deviceId: string, windowId: string, scope: string, oomKills: number): void;
  clear(deviceId: string, windowId: string): void;
  /** 该设备当前持久化了标记的窗口 id（跟踪器每 tick 据此清扫快照里已不存在的窗口）。 */
  listWindowIds(deviceId: string): string[];
  /** 设备删除时整体清掉。 */
  clearDevice(deviceId: string): void;
}

/** 网关侧注入给 tmux 连接的钩子。 */
export interface WindowMemoryConnectionHooks {
  getSettings(): WindowMemorySettings;
  oomMarks: WindowOomMarkStore;
  onSample(windows: WindowMemoryAggregate[]): void;
  onOomKill(event: WindowOomKillEvent): void;
  /** 宿主支持性判定完成时回调一次（每次连接）。 */
  onSupport?(supported: boolean): void;
}

export interface WindowMemoryTracker {
  /** 能不能量到内存（量不到就不发帧）。null = 尚未判定。 */
  readonly supported: boolean | null;
  /** 宿主能不能按窗口限额（cgroup v2 + systemctl --user + pane scope）。null = 尚未判定。 */
  readonly limitsSupported: boolean | null;
  start(): void;
  stop(): void;
  /** 立即执行一次采样（测试与「设置变更后立刻应用」用）。 */
  tick(): Promise<void>;
  getWindows(): WindowMemoryAggregate[];
  stopScopesForWindow(windowId: string): Promise<void>;
  stopScopesForPane(paneId: string): Promise<void>;
}
