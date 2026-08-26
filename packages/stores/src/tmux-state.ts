import type { StateSnapshotPayload } from '@tmex/shared';
import type { ConnectionState, GatewayHistoryCursor } from '@tmex/ws-client';

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

export interface DeviceInitialErrorInput {
  deviceId: string;
  lastError: string | null;
  lastErrorType: string | null;
}

export interface TmuxState {
  connectionState: ConnectionState;
  hasConnectedOnce: boolean;
  wsLatencyMs: number | null;
  snapshots: SnapshotMap;
  connectedDevices: Set<string>;
  deviceConnected: Record<string, boolean | undefined>;
  deviceErrors: Record<string, DeviceError | undefined>;
  deviceReconnecting: Record<string, DeviceReconnecting | undefined>;
  selectedPanes: Record<string, { windowId: string; paneId: string } | undefined>;
  activePaneFromEvent: Record<string, { windowId: string; paneId: string } | undefined>;
  pendingCreateWindowAt: Record<string, number | undefined>;

  ensureSocketConnected: () => void;
  connectDevice: (deviceId: string) => void;
  disconnectDevice: (deviceId: string) => void;
  clearDeviceError: (deviceId: string) => void;
  hydrateDeviceErrors: (entries: DeviceInitialErrorInput[]) => void;
  selectPane: (
    deviceId: string,
    windowId: string,
    paneId: string,
    size?: { cols?: number; rows?: number }
  ) => void;
  selectWindow: (deviceId: string, windowId: string) => void;
  sendInput: (deviceId: string, paneId: string, data: string, isComposing?: boolean) => void;
  resizePane: (deviceId: string, paneId: string, cols: number, rows: number) => void;
  syncPaneSize: (deviceId: string, paneId: string, cols: number, rows: number) => void;
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
