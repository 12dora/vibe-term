/**
 * 直连重掷策略：DC 与 ws-secure 共用同一套阈值 / 预算。外部路由变化会把已经很好的五元组
 * 改到慢路上，所以 live 链路要持续对照「该对端已知的最佳路径 RTT」再决定要不要重拨。
 *
 * 阈值口径：
 * - 至少 `DC_REROLL_MIN_SAMPLES` 个 ping 样本、链路存活 `DC_REROLL_MIN_LINK_AGE_MS`，避免抖动误判；
 * - 慢的定义是 `rtt > max(1.5 × best, best + 40ms)`，同时挡住小 RTT 的相对噪声与大 RTT 的绝对噪声；
 * - 每对端每滚动小时最多 `DC_REROLL_MAX_PER_HOUR` 次（DC 与 ws-secure 共用），间隔 ≥ 60 s；
 * - 只有 dial-initiator（`winningDialInitiator`，字典序较小的 nodeId）发起，且已协商 quiesce；
 * - DC 还要求对端报过 `reroll` 能力（2.3.1 不认更高 epoch 的 offer）；ws-secure 入站本来就会接新连接；
 * - 已能拨 DC 且 DC 升级在途 / 熔断放行时，不浪费预算去再赛一条 ws-secure（DC 升级会换掉它）。
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

export type DirectRerollTransport = 'dc' | 'ws-secure';

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
  /** 对端在 link.hello 里报过 reroll 能力。DC 重掷需要；ws-secure 入站不依赖它。 */
  peerCapable: boolean;
  /** dial-initiator（winningDialInitiator / 字典序较小的 nodeId）。 */
  isOfferer: boolean;
  breakerAllows: boolean;
  /** ws-secure：DC 可拨且升级已在途 / 熔断放行时为 true，避免白烧预算。 */
  dcUpgradePending?: boolean;
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

function isDirectRerollTransport(transport: string): transport is DirectRerollTransport {
  return transport === 'dc' || transport === 'ws-secure';
}

function measurementReason(input: DcRerollInput): string | null {
  if (!isDirectRerollTransport(input.transport)) return 'transport';
  if (input.rttMs == null || !Number.isFinite(input.rttMs)) return 'no-rtt';
  if (input.samples < DC_REROLL_MIN_SAMPLES) return 'samples';
  if (input.linkAgeMs < DC_REROLL_MIN_LINK_AGE_MS) return 'age';
  if (input.bestKnownMs == null || !Number.isFinite(input.bestKnownMs)) return 'no-best';
  return null;
}

function roleReason(input: DcRerollInput): string | null {
  if (!input.quiesceCapable) return 'quiesce';
  if (!input.isOfferer) return 'answerer';
  if (input.transport === 'ws-secure') {
    return input.dcUpgradePending ? 'dc-upgrade' : null;
  }
  if (!input.peerCapable) return 'peer-cap';
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
