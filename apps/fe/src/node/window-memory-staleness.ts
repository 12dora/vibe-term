// 窗口内存读数「是不是还代表现状」的口径。
//
// 两条来源判法不同，但都**不拿节点的 `sampledAt` 与浏览器时钟相减**——没对时的节点（容器、
// 虚机）会慢上几分钟，那样判会把它的每个读数都灰掉：
// - HTTP（`/api/sessions/memory`，设置页用）：网关明说 `stale` 就是过期；带 `sampledAgeMs`
//   （网关按自己的时钟算出的读数年龄）就按它判；只有老网关两样都不带时才退回跨机比较。
// - WS（WINDOW_MEMORY 帧，徽标用）：网关每个采样周期、至少每 30 s 给每个窗口发一帧，
//   帧停了读数才会变旧——主要看浏览器本地盖的 `receivedAt`，见 `isWindowMemoryFrameStale`。
//   唯一的跨机比较是「回放帧」兜底：2.8.0 及更早的网关每次连上都会重放缓存里的最后一次采样
//   （可能是几天前、关掉限额之前的），收到时刻是新的，采样时刻却远在
//   `WINDOW_MEMORY_REPLAY_STALE_MS` 之前，这种帧一到就灰显。

import { WINDOW_MEMORY_INTERVAL_MAX_SEC } from '@vibeterm/shared';

/** 网关对每个窗口至少 30 s 重发一帧，采样周期再短也不会比这更频繁地刷新读数。 */
const WINDOW_MEMORY_HEARTBEAT_MS = 30_000;
const STALE_PERIODS = 3;
/** 只在退回跨机比较时起作用：浏览器与网关的时钟差小于这个量不该把新读数判成过期。 */
const CLOCK_SKEW_MARGIN_MS = 60_000;
/** 连着两次心跳没收到新帧，徽标就灰显；再过一跳（见 stores 的 `WINDOW_MEMORY_STALE_MS`）整块收起。 */
export const WINDOW_MEMORY_FRAME_STALE_MS = 2 * WINDOW_MEMORY_HEARTBEAT_MS;
/**
 * 收到帧时采样时刻已落后浏览器时钟这么多，就当作旧网关重放的缓存读数。取 10 分钟：是跨机比较
 * 余量（60 s）的 10 倍、最长过期阈值（3 × 60 s 采样周期）的 3 倍多；没对时的晶振每天漂几秒，
 * 要漂出 10 分钟得几个月不校时，容器又与宿主共用时钟。只防节点时钟偏慢这一个方向——偏快的
 * 节点让采样时刻显得更新，不会被误判。
 */
export const WINDOW_MEMORY_REPLAY_STALE_MS = 10 * 60_000;

/** 读数年龄超过多久算过期；不知道采样周期时按上限 60 s 算，宁可晚判也不误判。 */
export function windowMemoryStaleAfterMs(intervalSec?: number | null): number {
  const intervalMs =
    typeof intervalSec === 'number' && Number.isFinite(intervalSec) && intervalSec > 0
      ? intervalSec * 1000
      : WINDOW_MEMORY_INTERVAL_MAX_SEC * 1000;
  return STALE_PERIODS * Math.max(intervalMs, WINDOW_MEMORY_HEARTBEAT_MS);
}

export interface WindowMemoryStalenessInput {
  sampledAt: number;
  now: number;
  intervalSec?: number | null;
  /** 网关明说过期（可选字段，老网关不带）。 */
  stale?: unknown;
  /** 网关按自己的时钟算出的读数年龄（毫秒，可选字段，老网关不带）。 */
  sampledAgeMs?: unknown;
  /** 设备已断开：读数不会再更新。缺省视为已连接。 */
  connected?: boolean;
}

function validAge(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** HTTP 读数的过期判定。 */
export function isWindowMemorySampleStale(input: WindowMemoryStalenessInput): boolean {
  if (input.stale === true) return true;
  if (input.connected === false) return true;
  if (!Number.isFinite(input.sampledAt) || input.sampledAt <= 0) return true;
  const limit = windowMemoryStaleAfterMs(input.intervalSec);
  const age = validAge(input.sampledAgeMs);
  if (age !== null) return age > limit;
  return input.now - input.sampledAt > limit + CLOCK_SKEW_MARGIN_MS;
}

export interface WindowMemoryFrameTimes {
  /** 节点时钟的采样时刻。 */
  sampledAt: number;
  /** 浏览器本地收到这一帧的时刻。 */
  receivedAt: number;
}

/** 旧网关重放的缓存读数：收到时采样时刻早已远超任何合理的时钟偏差。 */
export function isWindowMemoryFrameReplayed(frame: WindowMemoryFrameTimes): boolean {
  if (!Number.isFinite(frame.sampledAt)) return false;
  return frame.receivedAt - frame.sampledAt > WINDOW_MEMORY_REPLAY_STALE_MS;
}

/** WS 读数的过期判定：本地收到这一帧已超过两次心跳，或它本身就是重放的旧读数。 */
export function isWindowMemoryFrameStale(frame: WindowMemoryFrameTimes, now: number): boolean {
  if (!Number.isFinite(frame.receivedAt) || frame.receivedAt <= 0) return true;
  if (now - frame.receivedAt > WINDOW_MEMORY_FRAME_STALE_MS) return true;
  return isWindowMemoryFrameReplayed(frame);
}

/** 读数从什么时候起不再代表现状：重放帧按采样时刻（差出十分钟以上，时钟偏差可忽略），否则按收到时刻。 */
export function windowMemoryFrameStaleSince(frame: WindowMemoryFrameTimes): number {
  return isWindowMemoryFrameReplayed(frame) ? frame.sampledAt : frame.receivedAt;
}
