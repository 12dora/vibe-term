import { useCallback, useSyncExternalStore } from 'react';

export type DeviceConnectionStatus =
  | 'connected'
  | 'connecting'
  | 'disconnecting'
  | 'disconnected'
  | 'reconnecting'
  | 'error';

export interface DeviceConnectionAdapter {
  isConnected(deviceId: string): boolean;
  status(deviceId: string): DeviceConnectionStatus;
  isIntentionallyDisconnected(deviceId: string): boolean;
  connect(deviceId: string): void;
  disconnect(deviceId: string): void;
  /**
   * 按设备订阅连接态变化。适配器本身身份恒定（否则每次状态变化都会击穿所有行 / 卡片的
   * `React.memo`），状态改由这条订阅推给关心它的那一台设备。
   */
  subscribe(deviceId: string, onChange: () => void): () => void;
}

const NO_UNSUBSCRIBE = () => undefined;

function useDeviceConnectionSubscribe(
  connection: DeviceConnectionAdapter | undefined,
  deviceId: string
): (onChange: () => void) => () => void {
  return useCallback(
    (onChange: () => void) => connection?.subscribe(deviceId, onChange) ?? NO_UNSUBSCRIBE,
    [connection, deviceId]
  );
}

/** 只订阅本设备连接态的读取；宿主没接连接管理时为 undefined（调用方各自兜底） */
export function useDeviceConnectionStatus(
  connection: DeviceConnectionAdapter | undefined,
  deviceId: string
): DeviceConnectionStatus | undefined {
  const subscribe = useDeviceConnectionSubscribe(connection, deviceId);
  const read = useCallback(() => connection?.status(deviceId), [connection, deviceId]);
  return useSyncExternalStore(subscribe, read, read);
}

export function useDeviceIntentionallyDisconnected(
  connection: DeviceConnectionAdapter | undefined,
  deviceId: string
): boolean {
  const subscribe = useDeviceConnectionSubscribe(connection, deviceId);
  const read = useCallback(
    () => connection?.isIntentionallyDisconnected(deviceId) ?? false,
    [connection, deviceId]
  );
  return useSyncExternalStore(subscribe, read, read);
}
