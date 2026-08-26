import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import type { DeviceTreeOrderRecord } from '../db';
import { applyDeviceTreeOverlay } from './overlay-utils';
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

  applyWindowCustomNames(payload: StateSnapshotPayload): StateSnapshotPayload {
    const names = this.windowCustomNames.get(payload.deviceId);
    const paneNames = this.paneCustomNames.get(payload.deviceId);
    if ((!names?.size && !paneNames?.size) || !payload.session) return payload;

    const liveWindowIds = new Set(payload.session.windows.map((w) => w.id));
    for (const windowId of names?.keys() ?? []) {
      if (!liveWindowIds.has(windowId)) {
        names?.delete(windowId);
      }
    }

    const livePaneIds = new Set(
      payload.session.windows.flatMap((w) => w.panes.map((pane) => pane.id))
    );
    for (const paneId of paneNames?.keys() ?? []) {
      if (!livePaneIds.has(paneId)) {
        paneNames?.delete(paneId);
      }
    }

    return {
      ...payload,
      session: {
        ...payload.session,
        windows: payload.session.windows.map((window) => {
          const customName = names?.get(window.id);
          const panes = paneNames?.size
            ? window.panes.map((pane) => {
                const paneCustomName = paneNames.get(pane.id);
                return paneCustomName ? { ...pane, customName: paneCustomName } : pane;
              })
            : window.panes;
          return customName || panes !== window.panes
            ? { ...window, ...(customName ? { customName } : {}), panes }
            : window;
        }),
      },
    };
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

  encodeSnapshotWithOverlays(payload: StateSnapshotPayload): Uint8Array {
    const ordered = applyDeviceTreeOverlay(
      payload,
      this.getCachedDeviceTreeOrder(payload.deviceId)
    );
    return wsBorsh.encodeStateSnapshot(this.applyWindowCustomNames(ordered));
  }
}
