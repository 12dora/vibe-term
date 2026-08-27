export type DeviceConnectionStatus =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'reconnecting'
  | 'error';

export interface DeviceConnectionAdapter {
  isConnected(deviceId: string): boolean;
  status(deviceId: string): DeviceConnectionStatus;
  isIntentionallyDisconnected(deviceId: string): boolean;
  connect(deviceId: string): void;
  disconnect(deviceId: string): void;
}
