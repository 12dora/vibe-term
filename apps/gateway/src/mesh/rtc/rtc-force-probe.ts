/** 接收入站之后，紧接着的拨号门还要看得见这次接受。一个握手预算。 */
export const RTC_FORCE_PROBE_INBOUND_GRACE_MS = 15_000;
/** 失败的探测把间隔翻倍，封顶 2h。再密也救不回永远建不起的对端。 */
export const RTC_DIAL_FORCE_PROBE_MAX_MS = 2 * 60 * 60 * 1000;
/** 对端 decline 的 retryAfter / until 最多信 30min。 */
export const RTC_DECLINE_BACKOFF_CAP_MS = 30 * 60 * 1000;
/** 出站探测在间隔之外再推迟这么多，避免同一时刻集体拨号。只加不减。 */
export const RTC_DIAL_FORCE_PROBE_JITTER_MS = 60_000;

export type DisabledProbeRow = {
  lastProbeAt: number;
  probeArmedAt: number | null;
  /** 上次接收入站 offer 的时刻。和本端出站探测无关。 */
  lastInboundAcceptAt: number;
  /** noteInboundAccepted 之后的短窗口，让紧接着的拨号门还能看见这次接受。 */
  inboundHoldUntil: number;
  /** 已经 disabled 之后又失败的探测次数。造成 disable 的那几次不算。 */
  probeStrikes: number;
};

export type ProbeJitter = (peer: string, intervalMs: number) => number;

export type ProbeClock = {
  now: number;
  baseMs: number;
  jitter: ProbeJitter;
  peer: string;
};

export const NO_PROBE_JITTER: ProbeJitter = () => 0;

export function forceProbeIntervalMs(strikes: number, baseMs: number): number {
  const exp = Math.min(Math.max(0, Math.floor(strikes)), 8);
  return Math.min(baseMs * 2 ** exp, RTC_DIAL_FORCE_PROBE_MAX_MS);
}

/** 按对端 id 稳定散列。同一对端每次间隔的抖动不变，测试可以预算。 */
export function forceProbeJitterMs(peer: string, intervalMs: number): number {
  const window = Math.min(RTC_DIAL_FORCE_PROBE_JITTER_MS, Math.floor(intervalMs / 10));
  if (window <= 0) return 0;
  let hash = 2166136261;
  for (let i = 0; i < peer.length; i += 1) {
    hash ^= peer.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % (window + 1);
}

export function newDisabledRow(now: number): DisabledProbeRow {
  return {
    lastProbeAt: now,
    probeArmedAt: null,
    lastInboundAcceptAt: now,
    inboundHoldUntil: 0,
    probeStrikes: 0,
  };
}

export function noteProbeStrike(row: DisabledProbeRow): void {
  row.probeStrikes += 1;
}

export function beginOutboundProbe(row: DisabledProbeRow, now: number): void {
  row.lastProbeAt = row.probeArmedAt ?? now;
  row.probeArmedAt = null;
}

export function disabledProbeInterval(row: DisabledProbeRow, baseMs: number): number {
  return forceProbeIntervalMs(row.probeStrikes, baseMs);
}

function dueAt(from: number, row: DisabledProbeRow, clock: ProbeClock): number {
  const interval = disabledProbeInterval(row, clock.baseMs);
  return from + interval + clock.jitter(clock.peer, interval);
}

export function outboundProbeDueAt(row: DisabledProbeRow, clock: ProbeClock): number {
  return dueAt(row.lastProbeAt, row, clock);
}

export function inboundOpenAt(row: DisabledProbeRow, clock: ProbeClock): number {
  return dueAt(row.lastInboundAcceptAt, row, clock);
}

export function inboundSlotOpen(row: DisabledProbeRow, clock: ProbeClock): boolean {
  if (clock.now < row.inboundHoldUntil) return true;
  return clock.now >= inboundOpenAt(row, clock);
}

/** 入站槽开着才消耗。关着的槽不能被一次查询打开。 */
export function noteInboundAccepted(row: DisabledProbeRow, clock: ProbeClock): void {
  if (!inboundSlotOpen(row, clock)) return;
  row.lastInboundAcceptAt = clock.now;
  row.inboundHoldUntil = clock.now + RTC_FORCE_PROBE_INBOUND_GRACE_MS;
}

/** 到点才武装。返回 true 表示这次出站可以拨。 */
export function armOutboundProbe(row: DisabledProbeRow, clock: ProbeClock): boolean {
  if (row.probeArmedAt !== null) return true;
  if (clock.now < outboundProbeDueAt(row, clock)) return false;
  row.probeArmedAt = clock.now;
  return true;
}

/** disabled 时告诉对端下一次入站槽什么时候开。出站相位不参与。 */
export function refusalBackoff(
  row: DisabledProbeRow | undefined,
  coolingUntil: number | null,
  clock: ProbeClock
): { until: number | null; retryAfterMs: number } {
  if (row && !inboundSlotOpen(row, clock)) {
    const retryAfterMs = Math.max(0, inboundOpenAt(row, clock) - clock.now);
    return { until: clock.now + retryAfterMs, retryAfterMs };
  }
  if (coolingUntil != null && coolingUntil > clock.now) {
    return { until: coolingUntil, retryAfterMs: coolingUntil - clock.now };
  }
  return { until: null, retryAfterMs: 0 };
}
