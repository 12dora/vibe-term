// 窗口内存（systemd pane scope 按窗口聚合）在 store 里的形状与读取口径。
//
// 与宿主一跳延迟同构：网关按窗口下发，读数没变的心跳帧也要落地——`receivedAt` 是 UI 判断
// 「这台设备还在不在上报」的唯一依据，而它只能在收到时本地盖章：网关时钟与浏览器时钟未必
// 对齐，拿 `sampledAt` 判新鲜会把时钟慢的节点一直判死。

import type { WindowMemorySource } from '@vibeterm/shared';
import type { GatewayTransportEvent } from '@vibeterm/ws-client';

/** 一个窗口的内存读数；`high` / `max` / `swapMax` 为 0 表示未设限。 */
export interface WindowMemorySample {
  current: number;
  high: number;
  max: number;
  swapMax: number;
  oomKills: number;
  oomFlag: boolean;
  panes: number;
  /** 网关采样时刻（Unix 毫秒）：用于排序与丢乱序帧，不用来判新鲜。 */
  sampledAt: number;
  /** 本地收到这一帧的时刻（浏览器时钟）；新鲜度只按它判。 */
  receivedAt: number;
  /** `cgroup` = pane systemd scope（限额可用）；`rss` = 进程树 RSS 合计（宿主限不了）。 */
  source: WindowMemorySource;
}

export type WindowMemoryWindows = Record<string, WindowMemorySample | undefined>;

export type WindowMemoryMap = Record<string, WindowMemoryWindows | undefined>;

export type WindowMemoryEvent = Extract<GatewayTransportEvent, { type: 'window-memory' }>;

/** 网关每 30 s 至少给每个窗口播一次心跳帧；连丢三次就当它不再上报。 */
export const WINDOW_MEMORY_STALE_MS = 90_000;

function sameReading(prev: WindowMemorySample, event: WindowMemoryEvent): boolean {
  return (
    prev.current === event.current &&
    prev.high === event.high &&
    prev.max === event.max &&
    prev.swapMax === event.swapMax &&
    prev.oomKills === event.oomKills &&
    prev.oomFlag === event.oomFlag &&
    prev.panes === event.panes &&
    prev.source === event.source
  );
}

/**
 * 乱序旧帧一律丢（否则 `sampledAt` 会被倒回去）；同一采样时刻只有读数变了才算新消息。
 * 采样时刻前进的帧即便读数一模一样也要收下——它正是「还在上报」的证据。
 */
export function acceptsWindowMemory(prev: WindowMemorySample, event: WindowMemoryEvent): boolean {
  if (event.sampledAt !== prev.sampledAt) return event.sampledAt > prev.sampledAt;
  return !sameReading(prev, event);
}

export function applyWindowMemory(
  map: WindowMemoryMap,
  event: WindowMemoryEvent,
  receivedAt: number
): WindowMemoryMap {
  const windows = map[event.deviceId];
  const prev = windows?.[event.windowId];
  if (prev && !acceptsWindowMemory(prev, event)) return map;
  const sample: WindowMemorySample = {
    current: event.current,
    high: event.high,
    max: event.max,
    swapMax: event.swapMax,
    oomKills: event.oomKills,
    oomFlag: event.oomFlag,
    panes: event.panes,
    sampledAt: event.sampledAt,
    receivedAt,
    source: event.source,
  };
  return { ...map, [event.deviceId]: { ...windows, [event.windowId]: sample } };
}

/** 设备断开后这台设备的读数就过期了，留着只会让徽标继续显示一个不再更新的数字。 */
export function dropWindowMemoryForDevice(map: WindowMemoryMap, deviceId: string): WindowMemoryMap {
  if (!map[deviceId]) return map;
  const next = { ...map };
  delete next[deviceId];
  return next;
}

/** 快照里已经没有的窗口连同读数一起摘掉；没有要摘的就原样返回，不制造新引用。 */
export function pruneWindowMemoryWindows(
  map: WindowMemoryMap,
  deviceId: string,
  liveWindowIds: Iterable<string>
): WindowMemoryMap {
  const windows = map[deviceId];
  if (!windows) return map;
  const live = new Set(liveWindowIds);
  const kept = Object.keys(windows).filter((windowId) => live.has(windowId));
  if (kept.length === Object.keys(windows).length) return map;
  if (kept.length === 0) return dropWindowMemoryForDevice(map, deviceId);
  const next: WindowMemoryWindows = {};
  for (const windowId of kept) next[windowId] = windows[windowId];
  return { ...map, [deviceId]: next };
}

/**
 * 按**字段**读，不整对象读：网关每 30 s 重发一帧，读数一模一样，store 里换的却是一个新对象——
 * 整对象读会让 `useSyncExternalStore` 每次都判定为变更，徽标跟着空转。
 */
export function selectWindowMemoryField<K extends keyof WindowMemorySample>(
  map: WindowMemoryMap,
  deviceId: string | undefined,
  windowId: string | undefined,
  field: K
): WindowMemorySample[K] | null {
  if (!deviceId || !windowId) return null;
  return map[deviceId]?.[windowId]?.[field] ?? null;
}

/** 仍在上报的读数；过期（超过 `WINDOW_MEMORY_STALE_MS` 没有新帧）或没有则为 `null`。 */
export function freshWindowMemory(
  sample: WindowMemorySample | null,
  now: number
): WindowMemorySample | null {
  if (!sample) return null;
  return windowMemoryExpiryDelayMs(sample.receivedAt, now) === 0 ? null : sample;
}

/**
 * 距离这份读数被判过期还有多久；已经过期为 `0`。返回 `null` 表示这个时刻永远不会到来
 * （到达时刻缺席或不可信），调用方据此不必安排任何定时器。
 */
export function windowMemoryExpiryDelayMs(receivedAt: number | null, now: number): number | null {
  if (receivedAt === null || !Number.isFinite(receivedAt) || receivedAt <= 0) return null;
  return Math.max(0, receivedAt + WINDOW_MEMORY_STALE_MS - now);
}

/** 逐字段装配回样本；任一字段缺席即视作「这个窗口还没有读数」。 */
export function composeWindowMemorySample(fields: {
  current: number | null;
  high: number | null;
  max: number | null;
  swapMax: number | null;
  oomKills: number | null;
  oomFlag: boolean | null;
  panes: number | null;
  sampledAt: number | null;
  receivedAt: number | null;
  source: WindowMemorySource | null;
}): WindowMemorySample | null {
  const { current, high, max, swapMax, oomKills, oomFlag, panes, sampledAt, receivedAt, source } =
    fields;
  if (current === null || high === null || max === null || swapMax === null) return null;
  if (oomKills === null || oomFlag === null || panes === null || source === null) return null;
  if (sampledAt === null || receivedAt === null) return null;
  return { current, high, max, swapMax, oomKills, oomFlag, panes, sampledAt, receivedAt, source };
}
