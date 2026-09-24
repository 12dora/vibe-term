import { WINDOW_MEMORY_INTERVAL_MAX_SEC, WINDOW_MEMORY_INTERVAL_MIN_SEC } from '@vibeterm/shared';

/** 连续错过这么多个周期才把 HTTP 快照标成过期。 */
export const MEMORY_SAMPLE_STALE_TICKS = 6;
/** 再慢的一轮 systemctl 也不该把上一拍读数标过期。 */
export const MEMORY_SAMPLE_STALE_MIN_MS = 60_000;

export function memorySampleStaleAfterMs(intervalSec: number): number {
  const sec = Math.min(
    WINDOW_MEMORY_INTERVAL_MAX_SEC,
    Math.max(WINDOW_MEMORY_INTERVAL_MIN_SEC, intervalSec)
  );
  return Math.max(sec * 1000 * MEMORY_SAMPLE_STALE_TICKS, MEMORY_SAMPLE_STALE_MIN_MS);
}

/** `sampledAt <= 0` 是「还没采到」，不是过期读数。 */
export function isMemorySampleStale(sampledAt: number, now: number, intervalSec: number): boolean {
  if (!Number.isFinite(sampledAt) || sampledAt <= 0) return false;
  if (!Number.isFinite(now)) return false;
  return now - sampledAt > memorySampleStaleAfterMs(intervalSec);
}
