import type {
  SessionsMemoryDevice,
  SessionsMemoryResponse,
  SessionsMemoryWindow,
  StateSnapshotPayload,
  TmuxWindow,
} from '@vibeterm/shared';
import { getAllDevices } from '../db/devices';
import { getWindowOomMarkStore } from '../window-memory/oom-mark-store';
import { getWindowMemoryRuntime } from '../window-memory/runtime-host';
import type { WindowMemoryAggregate } from '../window-memory/types';
import { json } from './http';
import { type ApiRoute, route } from './route';

export const SESSIONS_MEMORY_PATH = '/api/sessions/memory';

function snapshotWindows(snapshot: StateSnapshotPayload | null): TmuxWindow[] {
  return snapshot?.session?.windows ?? [];
}

function zeroWindow(window: TmuxWindow, oomFlag: boolean): SessionsMemoryWindow {
  return {
    windowId: window.id,
    windowName: window.customName ?? window.name,
    panes: window.panes.length,
    scopes: [],
    current: 0,
    high: 0,
    max: 0,
    swapMax: 0,
    oomKills: 0,
    oomFlag,
    sampledAt: 0,
  };
}

function mergeWindow(
  window: TmuxWindow,
  agg: WindowMemoryAggregate | undefined,
  oomFlag: boolean
): SessionsMemoryWindow {
  const row = zeroWindow(window, oomFlag);
  if (!agg) return row;
  return {
    ...row,
    scopes: agg.scopes,
    current: agg.current,
    high: agg.high,
    max: agg.max,
    swapMax: agg.swapMax,
    oomKills: agg.oomKills,
    oomFlag: agg.oomFlag,
    sampledAt: agg.sampledAt,
  };
}

function windowsOf(
  deviceId: string,
  runtime: NonNullable<ReturnType<typeof getWindowMemoryRuntime>>
): SessionsMemoryWindow[] {
  const snapshot = runtime.getCurrentSnapshot?.() ?? null;
  const aggs = new Map((runtime.getWindowMemory?.() ?? []).map((agg) => [agg.windowId, agg]));
  const marks = getWindowOomMarkStore();
  return snapshotWindows(snapshot).map((window) =>
    mergeWindow(window, aggs.get(window.id), marks.has(deviceId, window.id))
  );
}

function toDeviceRow(deviceId: string, deviceName: string): SessionsMemoryDevice {
  const runtime = getWindowMemoryRuntime(deviceId);
  if (!runtime || runtime.isConnected?.() !== true) {
    return { deviceId, deviceName, connected: false, supported: false, windows: [] };
  }
  return {
    deviceId,
    deviceName,
    connected: true,
    supported: runtime.getWindowMemorySupported?.() === true,
    windows: windowsOf(deviceId, runtime),
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
