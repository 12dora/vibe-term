/** beginAttempt 关掉出站窗口后，对端同时发出的 offer 仍要接。一个握手预算。 */
export const RTC_FORCE_PROBE_INBOUND_GRACE_MS = 15_000;

export type DisabledProbeRow = {
  lastProbeAt: number;
  probeArmedAt: number | null;
  inboundOpenUntil: number;
};

export function forceProbeAcceptOpen(
  row: DisabledProbeRow,
  now: number,
  forceProbeMs: number
): boolean {
  if (row.probeArmedAt !== null) return true;
  if (now < row.inboundOpenUntil) return true;
  return now - row.lastProbeAt >= forceProbeMs;
}

/** disabled 时回「下次还会接 offer」的剩余时间；否则用冷却终点。 */
export function refusalBackoff(
  row: DisabledProbeRow | undefined,
  coolingUntil: number | null,
  now: number,
  forceProbeMs: number
): { until: number | null; retryAfterMs: number } {
  if (row && !forceProbeAcceptOpen(row, now, forceProbeMs)) {
    const retryAfterMs = Math.max(0, row.lastProbeAt + forceProbeMs - now);
    return { until: now + retryAfterMs, retryAfterMs };
  }
  if (coolingUntil != null && coolingUntil > now) {
    return { until: coolingUntil, retryAfterMs: coolingUntil - now };
  }
  return { until: null, retryAfterMs: 0 };
}
