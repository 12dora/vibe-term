// WebSocket 消息与 payload 契约

import type { DeviceEventType, TmuxEventType, TmuxSession } from './tmux';

export type WsMessageType =
  | 'connected'
  | 'error'
  | 'device/connect'
  | 'device/disconnect'
  | 'device/connected'
  | 'device/disconnected'
  | 'tmux/select'
  | 'tmux/select-window'
  | 'tmux/create-window'
  | 'tmux/close-window'
  | 'tmux/close-pane'
  | 'tmux/rename-window'
  | 'term/input'
  | 'term/resize'
  | 'term/sync-size'
  | 'term/paste'
  | 'term/history'
  | 'state/snapshot'
  | 'event/tmux'
  | 'event/device'
  | 'term/output';

export interface WsMessage<T = unknown> {
  type: WsMessageType;
  payload: T;
  timestamp: string;
}

export interface DeviceConnectPayload {
  deviceId: string;
}

export interface DeviceDisconnectPayload {
  deviceId: string;
}

export interface TmuxSelectPayload {
  deviceId: string;
  windowId?: string;
  paneId?: string;
}

export interface TmuxSelectWindowPayload {
  deviceId: string;
  windowId: string;
}

export interface TermInputPayload {
  deviceId: string;
  paneId: string;
  data: string;
  isComposing?: boolean;
}

export interface TermResizePayload {
  deviceId: string;
  paneId: string;
  cols: number;
  rows: number;
}

export interface TermPastePayload {
  deviceId: string;
  paneId: string;
  data: string;
}

export interface TermHistoryPayload {
  deviceId: string;
  paneId: string;
  data: string;
  alternateScreen?: boolean;
}

export interface CreateWindowPayload {
  deviceId: string;
  name?: string;
}

export interface CloseWindowPayload {
  deviceId: string;
  windowId: string;
}

export interface ClosePanePayload {
  deviceId: string;
  paneId: string;
}

export interface RenameWindowPayload {
  deviceId: string;
  windowId: string;
  name: string;
}

export interface StateSnapshotPayload {
  deviceId: string;
  session: TmuxSession | null;
}

export interface EventTmuxPayload {
  deviceId: string;
  type: TmuxEventType;
  data: unknown;
}

export interface EventDevicePayload {
  deviceId: string;
  type: DeviceEventType;
  errorType?: string;
  message?: string;
  rawMessage?: string;
}
