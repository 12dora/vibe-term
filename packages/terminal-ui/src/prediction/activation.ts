export const PREDICTION_AUTO_ON_RTT_MS = 50;
export const PREDICTION_AUTO_OFF_RTT_MS = 30;

/** 自适应开关的滞回：≥50 ms 打开，<30 ms 关闭，中间保持；未测得 RTT 时保持 */
export function nextAutoActive(previous: boolean, rttMs: number | null): boolean {
  if (rttMs === null || !Number.isFinite(rttMs)) return previous;
  if (rttMs >= PREDICTION_AUTO_ON_RTT_MS) return true;
  if (rttMs < PREDICTION_AUTO_OFF_RTT_MS) return false;
  return previous;
}
