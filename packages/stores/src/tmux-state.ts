import type { StateSnapshotPayload } from '@vibeterm/shared';
import type {
  ConnectionState,
  DeviceLatencyHop,
  GatewayHistoryCursor,
  StateFeedMode,
} from '@vibeterm/ws-client';
import type { TmuxTopologyPlaceholders } from './tmux-topology-cache';
import type { ViewportPolicyMap } from './viewport-policy';

export type SnapshotMap = Record<string, StateSnapshotPayload | undefined>;

export interface DeviceError {
  message: string;
  type: string;
  rawMessage?: string;
  at: number;
}

export interface DeviceReconnecting {
  message: string;
  at: number;
}

/** 网关测得的「网关 ↔ tmux server」一跳；`hop` 说明这一跳是本地还是经 SSH。 */
export interface DeviceLatencySample {
  rttMs: number;
  rawMs: number;
  hop: DeviceLatencyHop;
  /** 网关采样时刻（Unix 毫秒）。 */
  sampledAt: number;
}

export interface DeviceInitialErrorInput {
  deviceId: string;
  lastError: string | null;
  lastErrorType: string | null;
}

export interface TmuxState {
  connectionState: ConnectionState;
  stateFeedMode?: StateFeedMode;
  hasConnectedOnce: boolean;
  wsLatencyMs: number | null;
  wsLatencyRawMs: number | null;
  /** 各设备宿主一跳的延迟，键为 deviceId；旧节点不下发，永远为空。 */
  deviceLatency: Record<string, DeviceLatencySample | undefined>;
  /** 当前网关是否播报 device-latency-v1；为 false 时宿主一跳是「未测量」而非 0。 */
  deviceLatencySupported: boolean;
  snapshots: SnapshotMap;
  /**
   * 上一次会话缓存下来的窗口 / pane 拓扑，仅供冷启动时渲染灰显占位。
   * **绝不并入 `snapshots`**：选择恢复与路由对账只认实时数据，实时快照一到货这里就摘掉。
   */
  topologyPlaceholders: TmuxTopologyPlaceholders;
  connectedDevices: Set<string>;
  deviceConnected: Record<string, boolean | undefined>;
  deviceErrors: Record<string, DeviceError | undefined>;
  deviceReconnecting: Record<string, DeviceReconnecting | undefined>;
  selectedPanes: Record<string, { windowId: string; paneId: string } | undefined>;
  activePaneFromEvent: Record<string, { windowId: string; paneId: string } | undefined>;
  pendingCreateWindowAt: Record<string, number | undefined>;
  /** 网关下发的整窗尺寸归属，键为 `deviceId:paneId`；缺省（无记录）即本客户端是 owner */
  viewportPolicy: ViewportPolicyMap;

  ensureSocketConnected: () => void;
  connectDevice: (deviceId: string) => void;
  disconnectDevice: (deviceId: string) => void;
  clearDeviceError: (deviceId: string) => void;
  hydrateDeviceErrors: (entries: DeviceInitialErrorInput[]) => void;
  selectPane: (
    deviceId: string,
    windowId: string,
    paneId: string,
    size?: { cols?: number; rows?: number },
    /** warm：目标终端仍挂载且订阅中，只切 tmux 焦点，不拉 history、不 reset */
    options?: { warm?: boolean }
  ) => void;
  selectWindow: (deviceId: string, windowId: string) => void;
  sendInput: (deviceId: string, paneId: string, data: string, isComposing?: boolean) => void;
  resizePane: (deviceId: string, paneId: string, cols: number, rows: number) => void;
  syncPaneSize: (deviceId: string, paneId: string, cols: number, rows: number) => void;
  /** 视口声明：告诉网关本客户端在该 pane 上的可见状态与几何，供整窗尺寸仲裁 */
  setPaneViewport: (
    deviceId: string,
    paneId: string,
    viewport: { cols: number; rows: number; visible: boolean }
  ) => void;
  paste: (deviceId: string, paneId: string, data: string) => void;
  createWindow: (deviceId: string, name?: string, cwd?: string) => void;
  clearPendingCreateWindow: (deviceId: string) => void;
  closeWindow: (deviceId: string, windowId: string) => void;
  closePane: (deviceId: string, paneId: string) => void;
  renameWindow: (deviceId: string, windowId: string, name: string) => void;
  reorderWindows: (deviceId: string, windowIds: string[]) => void;
  reorderPanes: (deviceId: string, windowId: string, paneIds: string[]) => void;
  // ---------- 分屏 ----------
  subscribePanes: (deviceId: string, paneIds: string[]) => void;
  mountPane: (deviceId: string, paneId: string) => () => void;
  requestPaneScreen: (deviceId: string, paneId: string) => void;
  fetchPaneHistory: (
    deviceId: string,
    paneId: string,
    cursor?: GatewayHistoryCursor | null
  ) => void;
  focusPane: (deviceId: string, windowId: string, paneId: string) => void;
  splitPane: (deviceId: string, paneId: string, direction: 'right' | 'down', cwd?: string) => void;
  renamePane: (deviceId: string, paneId: string, name: string) => void;
  movePane: (
    deviceId: string,
    srcPaneId: string,
    dstPaneId: string,
    position: 'left' | 'right' | 'top' | 'bottom'
  ) => void;
  breakPane: (deviceId: string, paneId: string) => void;
  resizePaneInWindow: (
    deviceId: string,
    paneId: string,
    size: { cols?: number; rows?: number }
  ) => void;
  applyStackedLayout: (deviceId: string, windowId: string, cols: number, rows: number) => void;
  syncThemeAfterResize: (deviceId: string) => void;
}

export type TmuxGetState = () => TmuxState;

export type TmuxSetState = (
  partial: Partial<TmuxState> | ((prev: TmuxState) => Partial<TmuxState>)
) => void;

/** store 内部模块共享的读写面（zustand 的 set/get 直接满足） */
export interface TmuxStoreAccess {
  getState: TmuxGetState;
  setState: TmuxSetState;
}
