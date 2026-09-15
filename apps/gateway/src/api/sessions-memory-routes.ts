import type {
  SessionsMemoryDevice,
  SessionsMemoryResponse,
  StateSnapshotPayload,
} from '@vibeterm/shared';
import { getAllDevices } from '../db/devices';
import { getWindowMemoryRuntime } from '../window-memory/runtime-host';
import type { WindowMemoryAggregate } from '../window-memory/types';
import { json } from './http';
import { type ApiRoute, route } from './route';

export const SESSIONS_MEMORY_PATH = '/api/sessions/memory';

function windowNameOf(agg: WindowMemoryAggregate, snapshot: StateSnapshotPayload | null): string {
  const window = snapshot?.session?.windows.find((item) => item.id === agg.windowId);
  return window?.customName ?? window?.name ?? agg.windowName;
}

function toDeviceRow(deviceId: string, deviceName: string): SessionsMemoryDevice {
  const runtime = getWindowMemoryRuntime(deviceId);
  if (!runtime) {
    return { deviceId, deviceName, supported: false, windows: [] };
  }
  const snapshot = runtime.getCurrentSnapshot?.() ?? null;
  const windows = (runtime.getWindowMemory?.() ?? []).map((agg) => ({
    windowId: agg.windowId,
    windowName: windowNameOf(agg, snapshot),
    panes: agg.panes,
    scopes: agg.scopes,
    current: agg.current,
    high: agg.high,
    max: agg.max,
    swapMax: agg.swapMax,
    oomKills: agg.oomKills,
    oomFlag: agg.oomFlag,
    sampledAt: agg.sampledAt,
  }));
  return {
    deviceId,
    deviceName,
    supported: runtime.getWindowMemorySupported?.() === true,
    windows,
  };
}

function handleGet(): Response {
  const body: SessionsMemoryResponse = {
    devices: getAllDevices().map((device) => toDeviceRow(device.id, device.name)),
  };
  return json(body);
}

export const sessionsMemoryRoutes: ApiRoute[] = [
  route({ method: 'GET', path: SESSIONS_MEMORY_PATH, handler: () => handleGet() }),
];
