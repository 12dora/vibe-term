import type { DeviceConnectionStatus } from '@tmex/panels';

export interface DeviceConnectionSnapshot {
  /** 用户主动断开的设备（连接意图），优先级最高 */
  intentionallyDisconnected: ReadonlySet<string>;
  /** tmux store 已订阅集合 */
  connectedDevices: ReadonlySet<string>;
  deviceConnected: Record<string, boolean | undefined>;
  deviceErrors: Record<string, unknown>;
  deviceReconnecting: Record<string, unknown>;
}

/** 连接状态所依赖的 tmux store 切片（不含用户连接意图） */
export type DeviceRuntimeSlices = Omit<DeviceConnectionSnapshot, 'intentionallyDisconnected'>;

export function createDeviceConnectionSnapshot(
  intentionallyDisconnected: ReadonlySet<string>,
  slices: DeviceRuntimeSlices
): DeviceConnectionSnapshot {
  return { intentionallyDisconnected, ...slices };
}

function ownValue<T>(record: Record<string, T | undefined>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export function isDeviceConnected(
  deviceConnected: Record<string, boolean | undefined>,
  deviceId: string
): boolean {
  return ownValue(deviceConnected, deviceId) === true;
}

export function deriveDeviceConnectionStatus(
  deviceId: string,
  snapshot: DeviceConnectionSnapshot
): DeviceConnectionStatus {
  if (!deviceId) return 'disconnected';
  if (snapshot.intentionallyDisconnected.has(deviceId)) return 'disconnected';
  if (ownValue(snapshot.deviceReconnecting, deviceId)) return 'reconnecting';
  if (ownValue(snapshot.deviceErrors, deviceId)) return 'error';
  if (isDeviceConnected(snapshot.deviceConnected, deviceId)) return 'connected';
  if (snapshot.connectedDevices.has(deviceId)) return 'connecting';
  return 'disconnected';
}

export function shouldEnsureRouteDeviceSubscription(
  deviceId: string | undefined,
  devicesData: { devices: Array<{ id: string }> } | undefined
): deviceId is string {
  return Boolean(
    deviceId && (!devicesData || devicesData.devices.some((device) => device.id === deviceId))
  );
}

/** 自动订阅入口的判定：主动断开的设备不再自动订阅，已订阅的不重复下发 */
export function shouldEnsureDeviceSubscription(
  deviceId: string,
  intentionallyDisconnected: ReadonlySet<string>,
  connectedDevices: ReadonlySet<string>
): boolean {
  if (!deviceId) return false;
  if (intentionallyDisconnected.has(deviceId)) return false;
  return !connectedDevices.has(deviceId);
}

/** 已订阅但设备已从列表中删除，需要主动退订 */
export function selectStaleSubscribedDeviceIds(
  connectedDevices: ReadonlySet<string>,
  knownDeviceIds: ReadonlySet<string>
): string[] {
  return [...connectedDevices].filter((deviceId) => !knownDeviceIds.has(deviceId));
}

/** 持久化的连接意图中仍然存在、且尚未订阅的设备，需要恢复订阅 */
export function selectRestorableDeviceIds(
  persistedConnected: ReadonlySet<string>,
  knownDeviceIds: ReadonlySet<string>,
  intentionallyDisconnected: ReadonlySet<string>,
  connectedDevices: ReadonlySet<string>
): string[] {
  return [...persistedConnected].filter(
    (deviceId) =>
      knownDeviceIds.has(deviceId) &&
      shouldEnsureDeviceSubscription(deviceId, intentionallyDisconnected, connectedDevices)
  );
}
