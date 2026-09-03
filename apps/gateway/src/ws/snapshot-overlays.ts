import type { StateSnapshotPayload } from '@tmex/shared';
import type { DeviceTreeOrderRecord } from '../db';
import type { WebSocketServerDeps } from './types';

export interface SnapshotOverlayHost {
  readonly deps: WebSocketServerDeps;
}

export class SnapshotOverlayStore {
  readonly windowCustomNames = new Map<string, Map<string, string>>();
  readonly paneCustomNames = new Map<string, Map<string, string>>();
  private readonly deviceTreeOrders = new Map<string, DeviceTreeOrderRecord>();

  constructor(private readonly host: SnapshotOverlayHost) {}

  deleteDeviceTreeOrder(deviceId: string): void {
    this.deviceTreeOrders.delete(deviceId);
  }

  /** 清理已不存在于快照里的 stale 自定义名（canonical 投影按 id 维护，快照只用于回收）。 */
  pruneCustomNames(payload: StateSnapshotPayload): void {
    if (!payload.session) return;
    const names = this.windowCustomNames.get(payload.deviceId);
    const paneNames = this.paneCustomNames.get(payload.deviceId);
    if (!names?.size && !paneNames?.size) return;

    const liveWindowIds = new Set(payload.session.windows.map((window) => window.id));
    for (const windowId of [...(names?.keys() ?? [])]) {
      if (!liveWindowIds.has(windowId)) names?.delete(windowId);
    }
    const livePaneIds = new Set(
      payload.session.windows.flatMap((window) => window.panes.map((pane) => pane.id))
    );
    for (const paneId of [...(paneNames?.keys() ?? [])]) {
      if (!livePaneIds.has(paneId)) paneNames?.delete(paneId);
    }
  }

  storeDeviceTreeOrder(order: DeviceTreeOrderRecord): DeviceTreeOrderRecord {
    const stored = {
      deviceId: order.deviceId,
      windows: [...order.windows],
      panes: Object.fromEntries(
        Object.entries(order.panes).map(([windowId, paneIds]) => [windowId, [...paneIds]])
      ),
    };
    this.deviceTreeOrders.set(order.deviceId, stored);
    return stored;
  }

  getCachedDeviceTreeOrder(deviceId: string): DeviceTreeOrderRecord {
    const cached = this.deviceTreeOrders.get(deviceId);
    if (cached) {
      return cached;
    }
    return this.storeDeviceTreeOrder(this.host.deps.loadDeviceTreeOrder(deviceId));
  }
}
