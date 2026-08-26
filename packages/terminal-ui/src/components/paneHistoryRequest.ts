const MIN_HISTORY_DEADLINE_MS = 15_000;
const MAX_HISTORY_DEADLINE_MS = 60_000;
const HISTORY_DEADLINE_LATENCY_FACTOR = 8;
/** 视口离缓冲区顶部这么多行以内才认为用户真的在往回翻，可以补拉更旧的 history */
const HISTORY_PREFETCH_VIEWPORT_ROWS = 3;

/** 在途请求的放弃时限：按链路 RTT 放大，夹在 15s~60s 之间 */
export function historyRequestDeadlineMs(latencyMs: number | null | undefined): number {
  return Math.min(
    MAX_HISTORY_DEADLINE_MS,
    Math.max(MIN_HISTORY_DEADLINE_MS, (latencyMs ?? 0) * HISTORY_DEADLINE_LATENCY_FACTOR)
  );
}

export function shouldRequestOlderHistory({
  deltaY,
  requestInFlight,
  viewportY,
}: {
  deltaY: number;
  requestInFlight: boolean;
  viewportY: number;
}): boolean {
  if (deltaY >= 0 || requestInFlight) {
    return false;
  }
  return viewportY <= HISTORY_PREFETCH_VIEWPORT_ROWS;
}
