// 连接态的按设备分发：适配器身份恒定（见 `DeviceConnectionAdapter.subscribe`），
// 一台设备的状态变化只唤醒订阅了这台设备的行 / 卡片，不再让整棵设备树重渲染。
//
// 快照只在提交后由 `publish` 写入（provider 的 useLayoutEffect）：渲染期写外部 store 会让
// 被放弃的并发渲染也把值漏出去，而写入与通知合成一步则保证读到的永远是已提交的那一帧。

import type { DeviceConnectionStatus } from '@tmex/panels';
import {
  type DeviceConnectionSnapshot,
  deriveDeviceConnectionStatus,
  isDeviceConnected,
} from './device-connection-status';

interface DeviceStatusEntry {
  status: DeviceConnectionStatus;
  intentionallyDisconnected: boolean;
  listeners: Set<() => void>;
}

export class DeviceStatusStore {
  private snapshot: DeviceConnectionSnapshot;
  private readonly entries = new Map<string, DeviceStatusEntry>();

  constructor(snapshot: DeviceConnectionSnapshot) {
    this.snapshot = snapshot;
  }

  /** 提交后调用：写入快照并唤醒推导值真的变了的那几台设备 */
  publish = (snapshot: DeviceConnectionSnapshot): void => {
    this.snapshot = snapshot;
    for (const [deviceId, entry] of this.entries) {
      const status = this.status(deviceId);
      const intentionallyDisconnected = this.isIntentionallyDisconnected(deviceId);
      if (status === entry.status && intentionallyDisconnected === entry.intentionallyDisconnected)
        continue;
      entry.status = status;
      entry.intentionallyDisconnected = intentionallyDisconnected;
      for (const listener of [...entry.listeners]) listener();
    }
  };

  isConnected = (deviceId: string): boolean =>
    isDeviceConnected(this.snapshot.deviceConnected, deviceId);

  status = (deviceId: string): DeviceConnectionStatus =>
    deriveDeviceConnectionStatus(deviceId, this.snapshot);

  isIntentionallyDisconnected = (deviceId: string): boolean =>
    this.snapshot.intentionallyDisconnected.has(deviceId);

  subscribe = (deviceId: string, listener: () => void): (() => void) => {
    const entry = this.entries.get(deviceId) ?? this.track(deviceId);
    entry.listeners.add(listener);
    return () => {
      const current = this.entries.get(deviceId);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) this.entries.delete(deviceId);
    };
  };

  private track(deviceId: string): DeviceStatusEntry {
    const entry: DeviceStatusEntry = {
      status: this.status(deviceId),
      intentionallyDisconnected: this.isIntentionallyDisconnected(deviceId),
      listeners: new Set<() => void>(),
    };
    this.entries.set(deviceId, entry);
    return entry;
  }
}
