// 按窗口的内存读数与宿主限额支持性：`GET /api/sessions/memory`。
// 老网关不带 `limitsSupported` / `source`：前者按「尚未判定」（null）处理，后者只可能是 cgroup 语义。

import type {
  SessionsMemoryDevice,
  SessionsMemoryResponse,
  SessionsMemoryWindow,
  WindowMemorySource,
} from '@vibeterm/shared';
import { type ApiClient, defaultApiClient } from './client';
import { requestJson } from './json-mutation';

export const SESSIONS_MEMORY_PATH = '/api/sessions/memory';

export const sessionsMemoryQueryKey = ['sessions-memory'] as const;

type SessionsMemoryWire = { devices?: unknown };

function numberOr(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringOr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeSource(value: unknown): WindowMemorySource {
  return value === 'rss' ? 'rss' : 'cgroup';
}

/** 只认布尔；缺席或非法都是「尚未判定」，调用方不该据此提示限额不可用。 */
function normalizeLimitsSupported(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function sampledAgeMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function normalizeWindow(wire: Record<string, unknown>): SessionsMemoryWindow {
  const scopes = Array.isArray(wire.scopes) ? wire.scopes : [];
  const age = sampledAgeMs(wire.sampledAgeMs);
  return {
    windowId: stringOr(wire.windowId),
    windowName: stringOr(wire.windowName),
    scopes: scopes.filter((scope): scope is string => typeof scope === 'string'),
    current: numberOr(wire.current),
    high: numberOr(wire.high),
    max: numberOr(wire.max),
    swapMax: numberOr(wire.swapMax),
    oomKills: numberOr(wire.oomKills),
    oomFlag: wire.oomFlag === true,
    panes: numberOr(wire.panes),
    sampledAt: numberOr(wire.sampledAt),
    source: normalizeSource(wire.source),
    ...(wire.stale === true ? { stale: true } : {}),
    ...(age === undefined ? {} : { sampledAgeMs: age }),
  };
}

function normalizeDevice(wire: Record<string, unknown>): SessionsMemoryDevice {
  const windows = Array.isArray(wire.windows) ? wire.windows : [];
  return {
    deviceId: stringOr(wire.deviceId),
    deviceName: stringOr(wire.deviceName),
    connected: wire.connected === true,
    supported: wire.supported === true,
    limitsSupported: normalizeLimitsSupported(wire.limitsSupported),
    windows: windows
      .filter(
        (window): window is Record<string, unknown> => typeof window === 'object' && window !== null
      )
      .map(normalizeWindow),
  };
}

function normalizeSessionsMemory(wire: SessionsMemoryWire): SessionsMemoryResponse {
  const devices = Array.isArray(wire?.devices) ? wire.devices : [];
  return {
    devices: devices
      .filter(
        (device): device is Record<string, unknown> => typeof device === 'object' && device !== null
      )
      .map(normalizeDevice),
  };
}

export async function getSessionsMemory(
  client: ApiClient = defaultApiClient
): Promise<SessionsMemoryResponse> {
  return requestJson<SessionsMemoryWire, SessionsMemoryResponse>(client, SESSIONS_MEMORY_PATH, {
    errorFallback: 'Failed to load session memory',
    pick: normalizeSessionsMemory,
  });
}

/**
 * 已连接、且宿主明确没有 pane scope 的设备：限额能写进设置，但落不到任何 cgroup 上。
 * `null`（尚未判定）不算进来——没判定出来就不该吓唬用户。
 */
export function devicesWithoutMemoryLimits(
  response: SessionsMemoryResponse
): SessionsMemoryDevice[] {
  return response.devices.filter((device) => device.connected && device.limitsSupported === false);
}

export type { SessionsMemoryDevice, SessionsMemoryResponse, SessionsMemoryWindow };
