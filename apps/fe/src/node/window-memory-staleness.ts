// 窗口内存读数「是不是还代表现状」的口径。
//
// 两条来源判法不同，但都**不拿节点的 `sampledAt` 与浏览器时钟相减**——没对时的节点（容器、
// 虚机）会慢上几分钟，那样判会把它的每个读数都灰掉：
// - HTTP（`/api/sessions/memory`，设置页用）：网关明说 `stale` 就是过期；带 `sampledAgeMs`
//   （网关按自己的时钟算出的读数年龄）就按它判；只有老网关两样都不带时才退回跨机比较。
// - WS（WINDOW_MEMORY 帧，徽标用）：网关每个采样周期、至少每 30 s 给每个窗口发一帧，
//   帧停了读数才会变旧——只看浏览器本地盖的 `receivedAt`，见 `isWindowMemoryFrameStale`。

import { WINDOW_MEMORY_INTERVAL_MAX_SEC } from '@vibeterm/shared';

/** 网关对每个窗口至少 30 s 重发一帧，采样周期再短也不会比这更频繁地刷新读数。 */
const WINDOW_MEMORY_HEARTBEAT_MS = 30_000;
const STALE_PERIODS = 3;
/** 只在退回跨机比较时起作用：浏览器与网关的时钟差小于这个量不该把新读数判成过期。 */
const CLOCK_SKEW_MARGIN_MS = 60_000;
/** 连着两次心跳没收到新帧，徽标就灰显；再过一跳（见 stores 的 `WINDOW_MEMORY_STALE_MS`）整块收起。 */
export const WINDOW_MEMORY_FRAME_STALE_MS = 2 * WINDOW_MEMORY_HEARTBEAT_MS;

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

/** WS 读数的过期判定：只看本地收到这一帧有多久。 */
export function isWindowMemoryFrameStale(receivedAt: number, now: number): boolean {
  if (!Number.isFinite(receivedAt) || receivedAt <= 0) return true;
  return now - receivedAt > WINDOW_MEMORY_FRAME_STALE_MS;
}
