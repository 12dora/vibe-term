import type { StateSnapshotPayload } from '@tmex/shared';
import { notifyDeviceClose } from '../agent/device-close-bus';

export interface WatchRuntimeLike {
  connect(): Promise<void>;
  capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string>;
  subscribe(listener: {
    onSnapshot?: (payload: StateSnapshotPayload) => void;
    onClose?: () => void;
  }): () => void;
  requestSnapshot(): void;
}

export interface WatchRuntimePoolDeps {
  acquireRuntime: (deviceId: string) => Promise<WatchRuntimeLike>;
  releaseRuntime: (deviceId: string, runtime?: WatchRuntimeLike) => Promise<void>;
}

export interface DeviceEntry {
  deviceId: string;
  ruleIds: Set<string>;
  runtime: WatchRuntimeLike | null;
  connecting: Promise<WatchRuntimeLike> | null;
  detach: (() => void) | null;
  acquired: boolean;
  lastSnapshot: StateSnapshotPayload | null;
}

export class WatchRuntimePool {
  private readonly devices = new Map<string, DeviceEntry>();

  constructor(private readonly deps: WatchRuntimePoolDeps) {}

  get(deviceId: string): DeviceEntry | undefined {
    return this.devices.get(deviceId);
  }

  lastSnapshot(deviceId: string): StateSnapshotPayload | null {
    return this.devices.get(deviceId)?.lastSnapshot ?? null;
  }

  addRule(deviceId: string, ruleId: string): DeviceEntry {
    let device = this.devices.get(deviceId);
    if (!device) {
      device = {
        deviceId,
        ruleIds: new Set(),
        runtime: null,
        connecting: null,
        detach: null,
        acquired: false,
        lastSnapshot: null,
      };
      this.devices.set(deviceId, device);
    }
    device.ruleIds.add(ruleId);
    return device;
  }

  async removeRule(deviceId: string, ruleId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      return;
    }
    device.ruleIds.delete(ruleId);
    if (device.ruleIds.size > 0) {
      return;
    }

    this.devices.delete(deviceId);
    if (device.connecting) {
      await device.connecting.catch(() => undefined);
    }
    const runtime = device.runtime ?? undefined;
    device.detach?.();
    device.detach = null;
    device.runtime = null;
    if (device.acquired) {
      device.acquired = false;
      try {
        await this.deps.releaseRuntime(deviceId, runtime);
      } catch (error) {
        console.error(`[watch] failed to release runtime ${deviceId}:`, error);
      }
    }
  }

  async ensureRuntime(device: DeviceEntry): Promise<WatchRuntimeLike> {
    if (device.runtime) {
      return device.runtime;
    }
    if (!device.connecting) {
      device.connecting = (async () => {
        const runtime = await this.deps.acquireRuntime(device.deviceId);
        device.acquired = true;
        try {
          await runtime.connect();
        } catch (error) {
          device.acquired = false;
          await this.deps.releaseRuntime(device.deviceId, runtime).catch(() => undefined);
          throw error;
        }

        if (this.devices.get(device.deviceId) !== device) {
          device.acquired = false;
          await this.deps.releaseRuntime(device.deviceId, runtime).catch(() => undefined);
          throw new Error(`watch rules for device ${device.deviceId} were removed`);
        }

        device.detach = runtime.subscribe({
          onSnapshot: (payload) => {
            device.lastSnapshot = payload;
          },
          onClose: () => {
            this.handleRuntimeClose(device, runtime);
          },
        });
        device.runtime = runtime;
        runtime.requestSnapshot();
        return runtime;
      })().finally(() => {
        device.connecting = null;
      });
    }
    return device.connecting;
  }

  private handleRuntimeClose(device: DeviceEntry, runtime: WatchRuntimeLike): void {
    if (device.runtime !== runtime) {
      return;
    }
    notifyDeviceClose(device.deviceId);
    device.detach?.();
    device.detach = null;
    device.runtime = null;
    device.lastSnapshot = null;
    if (device.acquired) {
      device.acquired = false;
      void this.deps.releaseRuntime(device.deviceId, runtime).catch((error) => {
        console.error(`[watch] failed to release runtime ${device.deviceId}:`, error);
      });
    }
  }
}
