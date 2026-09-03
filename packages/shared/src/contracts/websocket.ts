// WebSocket 消息与 payload 契约

import type { DeviceEventType, TmuxEventType, TmuxSession } from './tmux';

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
