/**
 * 中继 / hub 上行路径劣化判定：长连接可能从一开始就落在慢五元组上，或中途被运营商改路。
 * 阈值口径与 DC 重掷相同（`max(1.5×best, best+40)`），但证据来自心跳而非 EWMA：
 * 连续 3 次心跳（中继 15 s → ≥ 45 s）都慢、链路已存活 60 s、且当前没有在途流时才重赛。
 * 每主机每滚动小时最多 3 次，两次间隔至少 2 分钟。
 */
export const UPLINK_DEGRADE_MIN_CONSECUTIVE = 3;
export const UPLINK_DEGRADE_MIN_LINK_AGE_MS = 60_000;
export const UPLINK_DEGRADE_MULTIPLIER = 1.5;
export const UPLINK_DEGRADE_ADDITIVE_MS = 40;
export const UPLINK_DEGRADE_MAX_PER_HOUR = 3;
export const UPLINK_DEGRADE_WINDOW_MS = 60 * 60 * 1000;
export const UPLINK_DEGRADE_MIN_INTERVAL_MS = 120_000;
/** 新链路攒够这么多个心跳才结算 re-race_result。 */
export const UPLINK_DEGRADE_RESULT_SAMPLES = 3;

export type UplinkReraceBudget = { count: number; windowStartedAt: number };

export type UplinkDegradeInput = {
  heartbeatRttMs: number | null;
  consecutiveSlow: number;
  bestKnownMs: number | null;
  linkAgeMs: number;
  inFlightStreams: number;
  lastReraceAt: number | null;
  reraces: UplinkReraceBudget;
  now: number;
};

export type UplinkDegradeDecision =
  | { rerace: false; reason: string }
  | { rerace: true; reason: 'slow-path'; currentMs: number; bestMs: number };

export function uplinkDegradeSlowThresholdMs(bestKnownMs: number): number {
  return Math.max(
    UPLINK_DEGRADE_MULTIPLIER * bestKnownMs,
    bestKnownMs + UPLINK_DEGRADE_ADDITIVE_MS
  );
}

export function uplinkReraceBudgetInWindow(
  budget: UplinkReraceBudget,
  now: number
): UplinkReraceBudget {
  if (now - budget.windowStartedAt >= UPLINK_DEGRADE_WINDOW_MS) {
    return { count: 0, windowStartedAt: now };
  }
  return budget;
}

export function isUplinkHeartbeatSlow(heartbeatRttMs: number, bestKnownMs: number): boolean {
  return heartbeatRttMs > uplinkDegradeSlowThresholdMs(bestKnownMs);
}

function measurementReason(input: UplinkDegradeInput): string | null {
  if (input.heartbeatRttMs == null || !Number.isFinite(input.heartbeatRttMs)) return 'no-rtt';
  if (input.bestKnownMs == null || !Number.isFinite(input.bestKnownMs)) return 'no-best';
  if (input.consecutiveSlow < UPLINK_DEGRADE_MIN_CONSECUTIVE) return 'consecutive';
  if (input.linkAgeMs < UPLINK_DEGRADE_MIN_LINK_AGE_MS) return 'age';
  return null;
}

function idleReason(input: UplinkDegradeInput): string | null {
  if (input.inFlightStreams !== 0) return 'busy';
  return null;
}

function budgetReason(input: UplinkDegradeInput): string | null {
  if (uplinkReraceBudgetInWindow(input.reraces, input.now).count >= UPLINK_DEGRADE_MAX_PER_HOUR) {
    return 'budget';
  }
  if (
    input.lastReraceAt != null &&
    input.now - input.lastReraceAt < UPLINK_DEGRADE_MIN_INTERVAL_MS
  ) {
    return 'cooldown';
  }
  return null;
}

export function decideUplinkDegrade(input: UplinkDegradeInput): UplinkDegradeDecision {
  const blocked = measurementReason(input) ?? idleReason(input) ?? budgetReason(input);
  if (blocked) return { rerace: false, reason: blocked };
  const rttMs = input.heartbeatRttMs as number;
  const bestMs = input.bestKnownMs as number;
  if (rttMs <= uplinkDegradeSlowThresholdMs(bestMs)) {
    return { rerace: false, reason: 'within-threshold' };
  }
  return { rerace: true, reason: 'slow-path', currentMs: rttMs, bestMs };
}
