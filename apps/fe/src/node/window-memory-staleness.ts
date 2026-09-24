// 窗口内存读数「是不是还代表现状」的唯一口径：徽标与设置页共用。
//
// 读数本身会被网关缓存并在设备重连时原样重放，也会在采样停摆后留在 `/api/sessions/memory` 里——
// 几天前的 8 GB / 12 GB 限额不能当作当前限额摆出来。按「采样时刻离现在多久」判：
// 超过 3 个采样周期（且不短于 3 个心跳）就算过期；另留一分钟给两端时钟偏差。

import { WINDOW_MEMORY_INTERVAL_MAX_SEC } from '@vibeterm/shared';

/** 网关对每个窗口至少 30 s 重发一帧，采样周期再短也不会比这更频繁地刷新读数。 */
const WINDOW_MEMORY_HEARTBEAT_MS = 30_000;
const STALE_PERIODS = 3;
/** 浏览器与网关的时钟未必对齐；偏差小于这个量不该把新读数判成过期。 */
const CLOCK_SKEW_MARGIN_MS = 60_000;

/** 读数超过多久算过期；不知道采样周期时按上限 60 s 算，宁可晚判也不误判。 */
export function windowMemoryStaleAfterMs(intervalSec?: number | null): number {
  const intervalMs =
    typeof intervalSec === 'number' && Number.isFinite(intervalSec) && intervalSec > 0
      ? intervalSec * 1000
      : WINDOW_MEMORY_INTERVAL_MAX_SEC * 1000;
  return STALE_PERIODS * Math.max(intervalMs, WINDOW_MEMORY_HEARTBEAT_MS) + CLOCK_SKEW_MARGIN_MS;
}

export interface WindowMemoryStalenessInput {
  sampledAt: number;
  now: number;
  intervalSec?: number | null;
  /** 网关明说过期（可选字段，老网关不带）。 */
  stale?: unknown;
  /** 设备已断开：读数不会再更新。缺省视为已连接。 */
  connected?: boolean;
}

export function isWindowMemorySampleStale(input: WindowMemoryStalenessInput): boolean {
  if (input.stale === true) return true;
  if (input.connected === false) return true;
  if (!Number.isFinite(input.sampledAt) || input.sampledAt <= 0) return true;
  return input.now - input.sampledAt > windowMemoryStaleAfterMs(input.intervalSec);
}
