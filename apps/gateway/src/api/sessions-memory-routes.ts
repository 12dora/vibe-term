import type {
  SessionsMemoryDevice,
  SessionsMemoryResponse,
  SessionsMemoryWindow,
  StateSnapshotPayload,
  TmuxWindow,
  WindowMemorySource,
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

type SessionsMemoryRuntime = NonNullable<ReturnType<typeof getWindowMemoryRuntime>>;

function zeroWindow(
  window: TmuxWindow,
  oomFlag: boolean,
  source: WindowMemorySource
): SessionsMemoryWindow {
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
    source,
  };
}

function windowSource(
  agg: WindowMemoryAggregate | undefined,
  fallback: WindowMemorySource
): WindowMemorySource {
  if (agg?.source === 'rss' || agg?.source === 'cgroup') return agg.source;
  return fallback;
}

function mergeWindow(
  window: TmuxWindow,
  agg: WindowMemoryAggregate | undefined,
  oomFlag: boolean,
  fallbackSource: WindowMemorySource
): SessionsMemoryWindow {
  const source = windowSource(agg, fallbackSource);
  const row = zeroWindow(window, oomFlag, source);
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
    source,
  };
}

function windowsOf(
  deviceId: string,
  runtime: SessionsMemoryRuntime,
  fallbackSource: WindowMemorySource
): SessionsMemoryWindow[] {
  const snapshot = runtime.getCurrentSnapshot?.() ?? null;
  const aggs = new Map((runtime.getWindowMemory?.() ?? []).map((agg) => [agg.windowId, agg]));
  const marks = getWindowOomMarkStore();
  return snapshotWindows(snapshot).map((window) =>
    mergeWindow(window, aggs.get(window.id), marks.has(deviceId, window.id), fallbackSource)
  );
}

function readLimitsSupported(runtime: SessionsMemoryRuntime): boolean | null {
  return runtime.getWindowMemoryLimitsSupported?.() ?? null;
}

function toDeviceRow(deviceId: string, deviceName: string): SessionsMemoryDevice {
  const runtime = getWindowMemoryRuntime(deviceId);
  if (!runtime || runtime.isConnected?.() !== true) {
    return {
      deviceId,
      deviceName,
      connected: false,
      supported: false,
      limitsSupported: null,
      windows: [],
    };
  }
  const limitsSupported = readLimitsSupported(runtime);
  return {
    deviceId,
    deviceName,
    connected: true,
    supported: runtime.getWindowMemorySupported?.() === true,
    limitsSupported,
    windows: windowsOf(deviceId, runtime, limitsSupported === false ? 'rss' : 'cgroup'),
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
