// 连接态的按设备分发：适配器身份恒定（见 `DeviceConnectionAdapter.subscribe`），
// 一台设备的状态变化只唤醒订阅了这台设备的行 / 卡片，不再让整棵设备树重渲染。
//
// 快照在 provider 的渲染期写入（读取立刻可见、SSR 也拿得到最新值），通知留到提交后
// （`notifyChanged`）——渲染期通知别的组件 setState 是非法的。

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

  setSnapshot = (snapshot: DeviceConnectionSnapshot): void => {
    this.snapshot = snapshot;
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

  /** 提交后调用：只唤醒推导值真的变了的那几台设备 */
  notifyChanged = (): void => {
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
