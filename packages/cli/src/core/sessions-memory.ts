// `vibeterm sessions`：给 HTTP 里 connected:false 的设备补窗口列表（必要时再等 window-memory）。

import {
  type SessionsMemoryDevice,
  type SessionsMemoryWindow,
  type TmuxSession,
  type TmuxWindow,
  WINDOW_MEMORY_SETTINGS_DEFAULTS,
} from '@vibeterm/shared';
import { type GatewayTransportEvent, serverSupportsWindowMemory } from '@vibeterm/ws-client';
import type { CliContext } from './context';
import { openDeviceSession } from './tmux-ops';

export const SESSIONS_WS_CONCURRENCY = 4;

export type SessionsDeviceRow = Omit<SessionsMemoryDevice, 'connected'> & { connected?: boolean };

export type WindowMemoryTransportEvent = Extract<GatewayTransportEvent, { type: 'window-memory' }>;

export function deviceIsConnected(device: SessionsDeviceRow): boolean {
  if (typeof device.connected === 'boolean') return device.connected;
  return (device.windows?.length ?? 0) > 0 || device.supported === true;
}

export function windowMemoryCollectTimeoutMs(sampleIntervalSec: number): number {
  return 2 * sampleIntervalSec * 1000 + 3000;
}

function emptyWindow(window: TmuxWindow): SessionsMemoryWindow {
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
    oomFlag: false,
    sampledAt: 0,
  };
}

export function windowsFromTree(tree: TmuxSession): SessionsMemoryWindow[] {
  return tree.windows.map(emptyWindow);
}

export function applyMemorySample(
  window: SessionsMemoryWindow,
  sample: WindowMemoryTransportEvent
): SessionsMemoryWindow {
  return {
    ...window,
    current: sample.current,
    high: sample.high,
    max: sample.max,
    swapMax: sample.swapMax,
    oomKills: sample.oomKills,
    oomFlag: sample.oomFlag,
    panes: sample.panes,
    sampledAt: sample.sampledAt,
  };
}

export async function readSampleIntervalSec(ctx: CliContext, nodeId: string): Promise<number> {
  try {
    const raw = await ctx.http.json<unknown>(nodeId, 'GET', '/api/settings/window-memory');
    if (!raw || typeof raw !== 'object') return WINDOW_MEMORY_SETTINGS_DEFAULTS.sampleIntervalSec;
    const value = (raw as { sampleIntervalSec?: unknown }).sampleIntervalSec;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  } catch {
    // 读不到就用默认间隔，回退采集仍能结束。
  }
  return WINDOW_MEMORY_SETTINGS_DEFAULTS.sampleIntervalSec;
}

export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  const n = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export function waitForWindowMemory(
  windowIds: readonly string[],
  samples: ReadonlyMap<string, unknown>,
  attachNotify: (notify: () => void) => void,
  timeoutMs: number
): Promise<void> {
  const missing = (): boolean => windowIds.some((id) => !samples.has(id));
  if (!missing()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    attachNotify(() => {
      if (!missing()) finish();
    });
    function finish(): void {
      attachNotify(() => {});
      clearTimeout(timer);
      resolve();
    }
  });
}

export async function fillDisconnectedDevices(
  ctx: CliContext,
  devices: readonly SessionsDeviceRow[],
  memory: boolean
): Promise<SessionsDeviceRow[]> {
  const need = devices.filter((device) => !deviceIsConnected(device));
  if (need.length === 0) return [...devices];
  const nodeId = await ctx.targetNodeId();
  const interval = memory ? await readSampleIntervalSec(ctx, nodeId) : 0;
  const timeoutMs = windowMemoryCollectTimeoutMs(interval);
  const filled = await mapPool(need, SESSIONS_WS_CONCURRENCY, (device) =>
    fillOneDevice(ctx, device, memory, timeoutMs)
  );
  const byId = new Map(filled.map((device) => [device.deviceId, device]));
  return devices.map((device) => byId.get(device.deviceId) ?? device);
}

async function fillOneDevice(
  ctx: CliContext,
  device: SessionsDeviceRow,
  memory: boolean,
  timeoutMs: number
): Promise<SessionsDeviceRow> {
  try {
    return await collectDeviceSession(ctx, device, memory, timeoutMs);
  } catch {
    return device;
  }
}

async function collectDeviceSession(
  ctx: CliContext,
  device: SessionsDeviceRow,
  memory: boolean,
  timeoutMs: number
): Promise<SessionsDeviceRow> {
  const samples = new Map<string, WindowMemoryTransportEvent>();
  let notify = (): void => {};
  const opened = await openDeviceSession(ctx, device.deviceId, {
    onWindowMemory: (event) => {
      if (event.deviceId !== device.deviceId) return;
      samples.set(event.windowId, event);
      notify();
    },
  });
  try {
    const windows = windowsFromTree(opened.tree);
    if (!memory) return { ...device, windows };
    return await withMemorySamples(opened.session.serverCapabilities(), windows, samples, {
      attachNotify: (next) => {
        notify = next;
      },
      timeoutMs,
      device,
    });
  } finally {
    opened.close();
  }
}

async function withMemorySamples(
  capabilities: readonly string[],
  windows: SessionsMemoryWindow[],
  samples: Map<string, WindowMemoryTransportEvent>,
  opts: {
    attachNotify: (notify: () => void) => void;
    timeoutMs: number;
    device: SessionsDeviceRow;
  }
): Promise<SessionsDeviceRow> {
  const helloOk = serverSupportsWindowMemory(capabilities);
  if (!helloOk) return { ...opts.device, supported: false, windows };
  const ids = windows.map((window) => window.windowId);
  await waitForWindowMemory(ids, samples, opts.attachNotify, opts.timeoutMs);
  const merged = windows.map((window) => {
    const sample = samples.get(window.windowId);
    return sample ? applyMemorySample(window, sample) : window;
  });
  const gotAny = ids.length === 0 || ids.some((id) => samples.has(id));
  return { ...opts.device, supported: gotAny, windows: merged };
}
