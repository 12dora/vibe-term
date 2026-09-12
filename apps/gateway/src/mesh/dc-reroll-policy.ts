/**
 * DC 重掷（re-roll）策略：DataChannel 是一条 UDP 流，本地端口在建 PeerConnection 时才抽签，
 * 跨运营商边界时约三分之一的五元组会落在慢路径上。策略只看测量值：当前链路稳态 RTT 明显高于
 * 该对端已知的最佳路径 RTT 时，重新拨一条 DC（新 PC → 新端口对），make-before-break 换过去。
 *
 * 阈值口径：
 * - 至少 `DC_REROLL_MIN_SAMPLES` 个 ping 样本、链路存活 `DC_REROLL_MIN_LINK_AGE_MS`，避免抖动误判；
 * - 慢的定义是 `rtt > max(1.5 × best, best + 40ms)`，同时挡住小 RTT 的相对噪声与大 RTT 的绝对噪声；
 * - 每对端每滚动小时最多 `DC_REROLL_MAX_PER_HOUR` 次，两次间隔至少 `DC_REROLL_MIN_INTERVAL_MS`；
 * - 只有 offerer（字典序较小的 nodeId）发起，且当前链路已协商 quiesce（换链才是 MBB 而不是 park），
 *   对端还必须在 `link.hello` 里报过 `reroll` 能力（2.3.1 及更早不认重掷 offer，拨了必然白拨）。
 */
export const DC_REROLL_MIN_SAMPLES = 3;
export const DC_REROLL_MIN_LINK_AGE_MS = 20_000;
export const DC_REROLL_MULTIPLIER = 1.5;
export const DC_REROLL_ADDITIVE_MS = 40;
export const DC_REROLL_MAX_PER_HOUR = 3;
export const DC_REROLL_WINDOW_MS = 60 * 60 * 1000;
export const DC_REROLL_MIN_INTERVAL_MS = 60_000;
/** 新链路攒够这么多样本才结算 reroll_result。 */
export const DC_REROLL_RESULT_SAMPLES = 3;
/** 结算时限：ICE 最多 15 s、再攒 3 个 5 s 心跳，超时说明这条新链路不是本次重掷换上来的。 */
export const DC_REROLL_RESULT_DEADLINE_MS = 90_000;
/** 相对提升达到这个比例，才把旧链路上的在途流搬到新链路。 */
export const DC_REROLL_REHOME_GAIN = 0.3;
/** `link.hello` 里表示「认重掷 offer」的能力位。 */
export const DC_REROLL_CAP = 'reroll';

export type DcRerollBudget = { count: number; windowStartedAt: number };

export type DcRerollInput = {
  transport: string;
  /** 稳态 EWMA RTT。 */
  rttMs: number | null;
  /** 本条链路安装以来的 ping 样本数。 */
  samples: number;
  linkAgeMs: number;
  bestKnownMs: number | null;
  rerolls: DcRerollBudget;
  lastRerollAt: number | null;
  quiesceCapable: boolean;
  /** 对端在 link.hello 里报过 reroll 能力。 */
  peerCapable: boolean;
  isOfferer: boolean;
  breakerAllows: boolean;
  now: number;
};

export type DcRerollDecision =
  | { reroll: false; reason: string }
  | { reroll: true; reason: 'slow-path'; currentMs: number; bestMs: number };

export function dcRerollSlowThresholdMs(bestKnownMs: number): number {
  return Math.max(DC_REROLL_MULTIPLIER * bestKnownMs, bestKnownMs + DC_REROLL_ADDITIVE_MS);
}

/**
 * 滚动窗口过期就从 0 重新计数。判定与记账必须共用它：只判定不重置会让第一小时之后预算永久耗尽，
 * 只记账不重置则预算形同虚设。
 */
export function dcRerollBudgetInWindow(budget: DcRerollBudget, now: number): DcRerollBudget {
  if (now - budget.windowStartedAt >= DC_REROLL_WINDOW_MS)
    return { count: 0, windowStartedAt: now };
  return budget;
}

function measurementReason(input: DcRerollInput): string | null {
  if (input.transport !== 'dc') return 'transport';
  if (input.rttMs == null || !Number.isFinite(input.rttMs)) return 'no-rtt';
  if (input.samples < DC_REROLL_MIN_SAMPLES) return 'samples';
  if (input.linkAgeMs < DC_REROLL_MIN_LINK_AGE_MS) return 'age';
  if (input.bestKnownMs == null || !Number.isFinite(input.bestKnownMs)) return 'no-best';
  return null;
}

function roleReason(input: DcRerollInput): string | null {
  if (!input.quiesceCapable) return 'quiesce';
  if (!input.peerCapable) return 'peer-cap';
  if (!input.isOfferer) return 'answerer';
  if (!input.breakerAllows) return 'breaker';
  return null;
}

function budgetReason(input: DcRerollInput): string | null {
  if (dcRerollBudgetInWindow(input.rerolls, input.now).count >= DC_REROLL_MAX_PER_HOUR) {
    return 'budget';
  }
  if (input.lastRerollAt != null && input.now - input.lastRerollAt < DC_REROLL_MIN_INTERVAL_MS) {
    return 'cooldown';
  }
  return null;
}

export function decideDcReroll(input: DcRerollInput): DcRerollDecision {
  const blocked = measurementReason(input) ?? roleReason(input) ?? budgetReason(input);
  if (blocked) return { reroll: false, reason: blocked };
  const rttMs = input.rttMs as number;
  const bestMs = input.bestKnownMs as number;
  if (rttMs <= dcRerollSlowThresholdMs(bestMs))
    return { reroll: false, reason: 'within-threshold' };
  return { reroll: true, reason: 'slow-path', currentMs: rttMs, bestMs };
}
